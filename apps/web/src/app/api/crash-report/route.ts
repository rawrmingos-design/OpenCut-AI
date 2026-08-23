import { NextResponse } from "next/server";

export async function POST(req: Request) {
	try {
		const payload = await req.json();
		// Log the crash securely on the server side
		console.error("[CRASH_REPORT_API]", JSON.stringify(payload, null, 2));
		// In a real production setup, this is where you'd forward `payload.reports` to Sentry/DataDog
		return NextResponse.json({ success: true });
	} catch (_e) {
		return NextResponse.json({ error: "bad request" }, { status: 400 });
	}
}
