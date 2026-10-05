import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, Type } from "@earendil-works/pi-ai";
import {
	createRegistry,
	defineExtension,
	defineTask,
	defineTool,
	ROOT_CONVERSATION_ID,
} from "@earendil-works/pi-durable";
import { setup } from "rivetkit";
import { setupTest } from "rivetkit/test";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { piDurable } from "../src/durable/index.js";
import {
	createMockModel,
	type MockModel,
	toolCall,
} from "./helpers/mock-model.js";

/** Resolves when `signal` aborts. Tasks honor it so a closing harness never waits on them. */
function aborted(signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve) => {
		if (!signal || signal.aborted) return resolve();
		signal.addEventListener("abort", () => resolve(), { once: true });
	});
}

/** Lifecycle facts by actor key, recorded in this process where the actors run. */
const sleeps = new Map<string, number>();
const stopping = new Set<string>();
const keyOf = (c: { key: unknown[] }) => JSON.stringify(c.key);
async function waitForSleeps(key: string[], count: number) {
	// Sleep completes after the action that asked for it returns, and onSleep records it in this process.
	await vi.waitFor(
		() =>
			expect(sleeps.get(JSON.stringify(key)) ?? 0).toBeGreaterThanOrEqual(
				count,
			),
		{
			timeout: 20_000,
		},
	);
}

/** The tool of the drain test waits for `release`. Unsafe, so a rerun would show as an interruption. */
let deployRuns = 0;
const release = Promise.withResolvers<void>();
const deployTool = defineTool({
	name: "deploy_tool",
	description: "An unsafe tool that waits",
	parameters: Type.Object({}),
	replay: "unsafe",
	execute: async () => {
		deployRuns += 1;
		await release.promise;
		return { content: [{ type: "text", text: "deployed" }] };
	},
});

/** The tool of the destroy test runs until it is stopped. This process records both. */
const blocking = { started: 0, stopped: 0 };
const blockingTool = defineTool({
	name: "blocking_tool",
	description: "A tool that runs until it is stopped",
	parameters: Type.Object({}),
	replay: "safe",
	execute: async (_args, _api, context) => {
		blocking.started += 1;
		await aborted(context.abortSignal);
		blocking.stopped += 1;
		context.abortSignal?.throwIfAborted();
		return { content: [{ type: "text", text: "stopped" }] };
	},
});

type JobInput = Record<string, never>;
const jobV1 = defineTask<JobInput, { phase: "run" }, string>({
	name: "app.job",
	version: 1,
	initial: () => ({ phase: "run" }),
	phases: {
		run: async (_task, _runtime, context) => aborted(context.abortSignal),
	},
	abort: async (_task, runtime, context) => {
		await runtime.commit(
			() => ({ status: "terminal", outcome: { status: "aborted" } }),
			context,
		);
	},
});
const jobV2 = (withMigrate: boolean) =>
	defineTask<JobInput, { phase: "run" } | { phase: "finish" }, string>({
		name: "app.job",
		version: 2,
		initial: () => ({ phase: "run" }),
		phases: {
			run: async (_task, _runtime, context) => aborted(context.abortSignal),
			finish: async (_task, runtime, context) => {
				await runtime.commit(
					() => ({
						status: "terminal",
						outcome: { status: "completed", result: "migrated" },
					}),
					context,
				);
			},
		},
		abort: async (_task, runtime, context) => {
			await runtime.commit(
				() => ({ status: "terminal", outcome: { status: "aborted" } }),
				context,
			);
		},
		...(withMigrate
			? {
					migrate: (input) => ({
						input: input as JobInput,
						checkpoint: { phase: "finish" as const },
					}),
				}
			: {}),
	});

let mockModel: MockModel;
let registry: ReturnType<typeof buildRegistry>;
const migratingJobs = createRegistry();
const strandedJobs = createRegistry();

function buildRegistry(mock: MockModel) {
	const models = {
		model: "mock/mock-model",
		providers: { mock: mock.providerConfig },
		apiKeys: { mock: "mock" },
	};
	const lifecycle = {
		onWake: (c: { key: unknown[]; abortSignal: AbortSignal }) => {
			c.abortSignal.addEventListener("abort", () => stopping.add(keyOf(c)), {
				once: true,
			});
		},
		onSleep: (c: { key: unknown[] }) => {
			sleeps.set(keyOf(c), (sleeps.get(keyOf(c)) ?? 0) + 1);
		},
	};
	const tools = createRegistry();
	tools.install(
		defineExtension({ name: "deploy", tools: [deployTool, blockingTool] }),
	);
	const drainer = piDurable({
		...models,
		...lifecycle,
		registry: tools,
		actions: {
			nap: (c) => {
				c.sleep();
			},
			destroySelf: (c) => {
				c.destroy();
			},
		},
	});
	const jobActions = {
		nap: (c: { sleep: () => void }) => {
			c.sleep();
		},
		startJob: async (c: {
			pi: import("@earendil-works/pi-durable").Harness;
		}) => {
			await c.pi.root(BACKGROUND_CONTEXT);
			return c.pi.commit(
				(tx) =>
					tx.createTask(
						jobV1,
						{},
						{
							ownership: { kind: "conversation" },
							conversationId: ROOT_CONVERSATION_ID,
						},
					),
				BACKGROUND_CONTEXT,
			);
		},
		bumpSchema: async (c: {
			db: { execute: (sql: string) => Promise<unknown> };
		}) => {
			await c.db.execute("UPDATE durable_schema SET version = version + 1");
		},
	};
	// The job runs until the stop interrupts it, so a short grace period ends the drain.
	const options = { sleepGracePeriod: 1_000 };
	const migrating = piDurable({
		...models,
		...lifecycle,
		options,
		registry: migratingJobs,
		actions: jobActions,
	});
	const stranded = piDurable({
		...models,
		...lifecycle,
		options,
		registry: strandedJobs,
		actions: jobActions,
	});
	return setup({ use: { drainer, migrating, stranded } });
}

beforeAll(() => {
	mockModel = createMockModel();
	registry = buildRegistry(mockModel);
	migratingJobs.install(defineExtension({ name: "jobs", tasks: [jobV1] }));
	strandedJobs.install(defineExtension({ name: "jobs", tasks: [jobV1] }));
	mockModel.reply(
		"deploy",
		toolCall("deploy_tool", {}),
		fauxAssistantMessage("deployed it"),
	);
	mockModel.reply("follow up", fauxAssistantMessage("followed up"));
	mockModel.reply(
		"wait for the stop",
		toolCall("blocking_tool", {}),
		fauxAssistantMessage("stopped"),
	);
});

describe("piDurable drain and upgrades", () => {
	test("a forced stop lets the run finish, and input sent during the stop is answered once after wake", async (c) => {
		const { client } = await setupTest(c, registry);
		const key = ["drain", randomUUID()];
		const handle = client.drainer.getOrCreate(key);
		const root = await handle.harness.root();
		const deploy = await handle.conversation.submit(root.id, {
			type: "input",
			content: "deploy",
		});
		// The tool runs in the background after submit returns; its counter lives in this process.
		await vi.waitFor(() => expect(deployRuns).toBe(1));

		await handle.nap();
		// Shutdown starts after the nap action returns; onWake's abort listener records it in this process.
		await vi.waitFor(() =>
			expect(stopping.has(JSON.stringify(key))).toBe(true),
		);
		// The gateway holds input sent during the stop and delivers it to the next generation.
		const followUp = {
			type: "input" as const,
			content: "follow up",
			requestId: "follow-up-1",
		};
		const sentDuringStop = handle.conversation.submit(root.id, followUp);
		release.resolve();
		const first = await sentDuringStop;
		expect(sleeps.get(JSON.stringify(key))).toBe(1);

		expect(await handle.submission.wait(deploy.id)).toMatchObject({
			status: "done",
		});
		const retry = await handle.conversation.submit(root.id, followUp);
		expect(retry.id).toBe(first.id);
		expect(await handle.submission.wait(first.id)).toMatchObject({
			status: "done",
		});

		expect(deployRuns).toBe(1);
		const { messages } = await handle.conversation.context(root.id);
		expect(
			messages.find((message) => message.role === "toolResult"),
		).toMatchObject({
			isError: false,
			content: [{ type: "text", text: expect.stringContaining("deployed") }],
		});
		const answers = messages.filter(
			(message) =>
				message.role === "assistant" &&
				message.content.some(
					(block) => block.type === "text" && block.text === "followed up",
				),
		);
		expect(answers).toHaveLength(1);
	});

	test("destroying an actor during a run stops the run without waiting for it", async (c) => {
		const { client } = await setupTest(c, registry);
		const handle = client.drainer.getOrCreate(["destroy", randomUUID()]);
		const root = await handle.harness.root();
		await handle.conversation.submit(root.id, {
			type: "input",
			content: "wait for the stop",
		});
		// The tool runs in the background after submit returns; its counter lives in this process.
		await vi.waitFor(() => expect(blocking.started).toBe(1));

		await handle.destroySelf();
		// The grace period is 15 minutes, so only a destroy that skips the drain stops the tool this soon.
		await vi.waitFor(() => expect(blocking.stopped).toBe(1), {
			timeout: 10_000,
		});
	});

	test("a task stored by version 1 resumes under version 2 through migrate", async (c) => {
		const { client } = await setupTest(c, registry);
		const key = ["migrate", randomUUID()];
		const handle = client.migrating.getOrCreate(key);
		const taskId = await handle.startJob();
		await handle.nap();
		await waitForSleeps(key, 1);

		migratingJobs.install(
			defineExtension({ name: "jobs", tasks: [jobV2(true)] }),
		);
		const settled = await handle.harness.waitForTask(taskId);
		expect(settled.state.outcome).toEqual({
			status: "completed",
			result: "migrated",
		});
	});

	test("a task stored by version 1 without a migrate is reported blocked by harness.inspect", async (c) => {
		const { client } = await setupTest(c, registry);
		const key = ["stranded", randomUUID()];
		const handle = client.stranded.getOrCreate(key);
		await handle.startJob();
		await handle.nap();
		await waitForSleeps(key, 1);

		strandedJobs.install(
			defineExtension({ name: "jobs", tasks: [jobV2(false)] }),
		);
		const inspection = await handle.harness.inspect();
		expect(inspection.tasks).toEqual([
			expect.objectContaining({
				record: expect.objectContaining({ kind: "app.job", version: 1 }),
				state: expect.objectContaining({
					kind: "blocked",
					reason: "migration_failed",
				}),
			}),
		]);
	});

	test("storage written by a newer Pi Durable schema makes actions fail with an internal error", async (c) => {
		const { client } = await setupTest(c, registry);
		const key = ["rollback", randomUUID()];
		const handle = client.migrating.getOrCreate(key);
		await handle.harness.root();
		await handle.bumpSchema();
		await handle.nap();
		await waitForSleeps(key, 1);

		// The caller cannot fix a rollback, so RivetKit hides Pi's message; the actor logs it.
		await expect(handle.harness.inspect()).rejects.toMatchObject({
			group: "rivetkit",
			code: "internal_error",
		});
	});
});
