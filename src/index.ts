/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run "npm run dev" in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run "npm run deploy" to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

async function generate256Hash(message: string) {
	const msgUint8 = new TextEncoder().encode(message); // encode as (utf-8) Uint8Array
	const hashBuffer = await crypto.subtle.digest("SHA-256", msgUint8); // hash the message
	const hashArray = Array.from(new Uint8Array(hashBuffer)); // convert buffer to byte array
	const hashHex = hashArray
		.map((b) => b.toString(16).padStart(2, "0"))
		.join(""); // convert bytes to hex string
	return hashHex;
}

export function durationToMs(
	value: number,
	unit: "seconds" | "minutes" | "hours" | "days" | "weeks",
): number {
	const multipliers = {
		seconds: 1000,
		minutes: 60 * 1000,
		hours: 60 * 60 * 1000,
		days: 24 * 60 * 60 * 1000,
		weeks: 7 * 24 * 60 * 60 * 1000,
	};
	return value * multipliers[unit];
}

type Release = {
	tag_name: string;
	html_url: string;
};
type Ping = {
	ping_timestamp: string;
};

export default {
	async fetch(request, env, ctx) {
		const addCors = (response: Response) => {
			response.headers.set("Access-Control-Allow-Origin", "*");
			response.headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
			response.headers.set(
				"Access-Control-Allow-Headers",
				"Content-Type, Authorization",
			);
			return response;
		};

		// Handle CORS preflight requests
		if (request.method === "OPTIONS") {
			return addCors(new Response(null));
		}

		const { pathname } = new URL(request.url);
		switch (pathname) {
			case "/makefile": {
				const ip = request.headers.get("cf-connecting-ip");
				if (ip) {
					const ipHash = await generate256Hash(ip);

					await env.DB.prepare(
						"INSERT INTO ip_registry (ip_hash) VALUES (?) ON CONFLICT (ip_hash) DO NOTHING",
					)
						.bind(ipHash)
						.all();
				}
				return fetch(
					"https://raw.githubusercontent.com/zane-ops/zane-ops/main/deploy.mk",
				);
			}
			case "/api/stats": {
				const {
					results: [data],
				} = await env.DB.prepare(
					"SELECT count(ip_hash) as total FROM ip_registry",
				).all();
				return Response.json(data);
			}
			case "/api/releases": {
				const releases: Array<Release> = await fetch(
					"https://api.github.com/repos/zane-ops/zane-ops/releases",
					{
						method: "GET",
						headers: {
							Accept: "application/json",
							Authorization: `Bearer ${env.GITHUB_PAT}`,
							"User-Agent": "Fredkiss3",
							"X-GitHub-Api-Version": "2022-11-28",
						},
					},
				).then((response) => response.json());
				console.log({ releases });

				return addCors(
					Response.json(
						releases.map((release) => ({
							tag: release.tag_name,
							url: release.html_url,
						})),
					),
				);
			}
			case "/api/latest-release": {
				const release: Release = await fetch(
					"https://api.github.com/repos/zane-ops/zane-ops/releases/latest",
					{
						method: "GET",
						headers: {
							Accept: "application/json",
							Authorization: `Bearer ${env.GITHUB_PAT}`,
							"User-Agent": "Fredkiss3",
							"X-GitHub-Api-Version": "2022-11-28",
						},
					},
				).then((response) => response.json());
				console.log({ release });
				return addCors(
					Response.json({
						tag: release.tag_name,
						url: release.html_url,
					}),
				);
			}
			case "/api/ping": {
				if (request.method !== "POST") {
					return new Response("Method Not Allowed", {
						status: 405,
						headers: {
							Allow: "POST",
							"Content-Type": "text/plain",
						},
					});
				}

				const ip = request.headers.get("cf-connecting-ip");
				if (ip) {
					const ipHash = await generate256Hash(ip);

					// insert IP if not in data
					await env.DB.prepare(
						"INSERT INTO ip_registry (ip_hash) VALUES (?) ON CONFLICT (ip_hash) DO NOTHING RETURNING *;",
					)
						.bind(ipHash)
						.all();

					// Check last ping time
					const lastPingResult: Ping | null = await env.DB.prepare(
						"SELECT ping_timestamp FROM ip_pings WHERE ip_hash = ? ORDER BY ping_timestamp DESC LIMIT 1;",
					)
						.bind(ipHash)
						.first();

					const currentTime = new Date();
					let shouldRecordPing = true;

					if (lastPingResult?.ping_timestamp) {
						const lastPingTime = new Date(lastPingResult.ping_timestamp);
						const hoursDifference =
							(currentTime.getTime() - lastPingTime.getTime()) /
							durationToMs(1, "hours");

						// Only record if more than 1 hour has passed
						shouldRecordPing = hoursDifference >= 1;
					}

					if (shouldRecordPing) {
						// Insert ping record
						await env.DB.prepare("INSERT INTO ip_pings (ip_hash) VALUES (?);")
							.bind(ipHash)
							.run();

						return Response.json({
							success: true,
							message: "Ping recorded successfully",
						});
					}

					return Response.json({
						success: false,
						message: "Ping not recorded - less than 1 hour since last ping",
					});
				}

				return Response.json(
					{
						success: false,
						message: "IP address not found in request",
					},
					{
						status: 400,
					},
				);
			}
			// case "/api/pings": {
			//   return Response.json({})
			// }
			default: {
				return addCors(
					new Response("Page not found!", {
						status: 404,
					}),
				);
			}
		}
	},
} satisfies ExportedHandler<Env>;
