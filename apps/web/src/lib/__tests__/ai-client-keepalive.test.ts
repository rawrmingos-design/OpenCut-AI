import { afterEach, describe, expect, test } from "bun:test";
import { aiClient, AIClientError } from "../ai-client";

/**
 * SCRUM-72 regression tests for requestWithKeepalive NDJSON parsing.
 *
 * Bug: transport chunks can split a JSON line across TCP boundaries.
 * The old implementation parsed each chunk independently and swallowed
 * JSON.parse failures, permanently losing the `{"result": ...}` line.
 */

function ndjsonResponse(chunks: string[], contentType = "application/x-ndjson"): Response {
	const encoder = new TextEncoder();
	let index = 0;
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (index < chunks.length) {
				controller.enqueue(encoder.encode(chunks[index]));
				index += 1;
			} else {
				controller.close();
			}
		},
	});
	return new Response(stream, {
		status: 200,
		headers: { "content-type": contentType },
	});
}

const SEGMENTS = [
	{
		id: 0,
		text: "Line one",
		start: 0,
		end: 4,
		words: [{ word: "one", start: 0, end: 1, confidence: 0.9 }],
	},
];

function stubFetch(handler: () => Promise<Response>): typeof fetch {
	const fn = (async () => handler()) as unknown as typeof fetch;
	return fn;
}

describe("requestWithKeepalive NDJSON framing", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("reassembles a result line split across two chunks", async () => {
		globalThis.fetch = stubFetch(() =>
			Promise.resolve(ndjsonResponse([
				'{"ping": true}\n{"result":{"cl',
				'ips": [{"id": "c1", "title": "T"}], "total_duration": 50}}\n',
			])),
		);

		const result = await aiClient.findClips(SEGMENTS);
		expect(result.clips).toHaveLength(1);
		expect(result.clips[0]?.id).toBe("c1");
		expect(result.total_duration).toBe(50);
	});

	test("returns a final line even without trailing newline", async () => {
		globalThis.fetch = stubFetch(() =>
			Promise.resolve(ndjsonResponse(['{"ping": true}\n{"result": {"clips": [], "total_duration": 12}}'])),
		);

		const result = await aiClient.findClips(SEGMENTS);
		expect(result.total_duration).toBe(12);
	});

	test("surfaces backend error lines as AIClientError", async () => {
		globalThis.fetch = stubFetch(() =>
			Promise.resolve(ndjsonResponse(['{"ping": true}\n', '{"error": "boom"}\n'])),
		);

		let caught: unknown;
		try {
			await aiClient.findClips(SEGMENTS);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(AIClientError);
		expect((caught as AIClientError).message).toBe("boom");
	});

	test("falls back to plain JSON responses", async () => {
		globalThis.fetch = stubFetch(() =>
			Promise.resolve(new Response(JSON.stringify({ clips: [{ id: "plain" }], total_duration: 5 }), {
				status: 200,
				headers: { "content-type": "application/json" },
			})),
		);

		const result = await aiClient.findClips(SEGMENTS);
		expect(result.clips[0]?.id).toBe("plain");
	});
});
