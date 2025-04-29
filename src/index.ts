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

async function generateHMAC256(message: string, secret: string) {
	const encoder = new TextEncoder();
	const keyData = encoder.encode(secret);
	const cryptoKey = await crypto.subtle.importKey(
		"raw",
		keyData,
		{ name: "HMAC", hash: { name: "SHA-256" } },
		false,
		["sign"],
	);
	const signed_message = await crypto.subtle.sign(
		"HMAC",
		cryptoKey,
		encoder.encode(message),
	);
	const hashArray = Array.from(new Uint8Array(signed_message));
	return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

// HMAC helper treats the SHA‐256 hex as the “message”
async function generateDoubleHash(ip: string, secret: string) {
	const sha = await generate256Hash(ip);
	const hmac = await generateHMAC256(sha, secret);
	return { sha, hmac };
}

function durationToMs(
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

async function upsertIp(ip: string, env: Env) {
	const { sha, hmac } = await generateDoubleHash(ip, env.IP_HASH_PEPPER);
	await env.DB.prepare(`
	  INSERT INTO ip_registry (ip_hash, ip_hmac)
	  VALUES (?, ?)
	  ON CONFLICT(ip_hash) DO UPDATE
		SET ip_hmac = EXCLUDED.ip_hmac
	`)
		.bind(sha, hmac)
		.run();
	return {
		sha,
		hmac,
	};
}

// Backfill existing rows
// async function backfillIpHmac(env: Env) {
// 	const { results } = await env.DB.prepare(
// 		"SELECT ip_hash FROM ip_registry WHERE ip_hmac IS NULL",
// 	).all<{ ip_hash: string }>();

// 	for (const { ip_hash } of results) {
// 		const hmac = await generateHMAC256(ip_hash, env.IP_HASH_PEPPER);
// 		await env.DB.prepare("UPDATE ip_registry SET ip_hmac = ? WHERE ip_hash = ?")
// 			.bind(hmac, ip_hash)
// 			.run();
// 	}
// }

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
					await upsertIp(ip, env);
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
				).all<{ total: number }>();
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
					const { hmac: ipHmac } = await upsertIp(ip, env);

					// Check last ping time
					const lastPingResult: Ping | null = await env.DB.prepare(
						"SELECT ping_timestamp FROM ip_pings WHERE ip_hmac = ? ORDER BY ping_timestamp DESC LIMIT 1;",
					)
						.bind(ipHmac)
						.first();

					const currentTime = new Date();
					let shouldRecordPing = true;

					if (lastPingResult?.ping_timestamp) {
						const lastPingTime = new Date(lastPingResult.ping_timestamp);
						const minutesDifference =
							(currentTime.getTime() - lastPingTime.getTime()) /
							durationToMs(30, "minutes");

						// Only record if more than 1 hour has passed
						shouldRecordPing = minutesDifference >= 1;
					}

					if (shouldRecordPing) {
						// Insert ping record
						await env.DB.prepare("INSERT INTO ip_pings (ip_hmac) VALUES (?);")
							.bind(ipHmac)
							.run();

						return Response.json({
							success: true,
							message: "Ping recorded successfully",
						});
					}

					return Response.json({
						success: false,
						message: "Ping not recorded - less than 30 minutes since last ping",
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
