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
	return await generateHMAC256(await generate256Hash(ip), secret);
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

function getDateRange(
	period: string,
	currentDate: Date = new Date(),
): { startISO: string; endISO: string } | null {
	const end = new Date(currentDate); // Make a copy
	let start = new Date(currentDate); // Make a copy

	switch (period) {
		case "24h":
			start.setHours(start.getHours() - 24);
			break;
		case "7d":
			start.setDate(start.getDate() - 7);
			start.setHours(0, 0, 0, 0); // Set to the beginning of the day
			break;
		case "30d":
			start.setDate(start.getDate() - 30);
			start.setHours(0, 0, 0, 0); // Set to the beginning of the day
			break;
		case "6month":
			start.setMonth(start.getMonth() - 6);
			start.setHours(0, 0, 0, 0); // Set to the beginning of the day
			break;
		case "all":
			return null;
		default:
			// Unrecognized period
			return null;
	}

	return {
		startISO: start.toISOString(),
		endISO: end.toISOString(),
	};
}

function parseQueryParam<T extends string>(
	value: string | null,
	defaultValue: T,
	allowedValues?: readonly T[],
): T {
	if (value && (!allowedValues || (allowedValues as readonly string[]).includes(value))) {
		return value as T;
	}
	return defaultValue;
}

type Release = {
	tag_name: string;
	html_url: string;
};
type Ping = {
	ping_timestamp: string;
};

async function upsertIp(ip: string, env: Env) {
	const hmac = await generateDoubleHash(ip, env.IP_HASH_PEPPER);
	await env.DB.prepare(`
	  INSERT INTO ip_registry (ip_hmac)
	  VALUES (?)
	  ON CONFLICT DO NOTHING
	`)
		.bind(hmac)
		.run();
	return {
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
					"SELECT count(id) as total FROM ip_registry",
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
			case "/api/pings": {
				if (request.method !== "GET") {
					return addCors(
						new Response("Method Not Allowed", {
							status: 405,
							headers: {
								Allow: "GET",
								"Content-Type": "text/plain",
							},
						}),
					);
				}

				const { results } = await env.DB.prepare(
					"SELECT ip_hmac, ping_timestamp FROM ip_pings ORDER BY ping_timestamp DESC",
				).all();
				return addCors(Response.json(results));
			}
			case "/api/stats/summary": {
				if (request.method !== "GET") {
					return addCors(
						new Response("Method Not Allowed", {
							status: 405,
							headers: { Allow: "GET", "Content-Type": "text/plain" },
						}),
					);
				}

				const totalPingsQuery = env.DB.prepare(
					"SELECT COUNT(*) as totalPings FROM ip_pings;",
				);
				const totalUniqueUsersQuery = env.DB.prepare(
					"SELECT COUNT(DISTINCT ip_hmac) as totalUniqueUsers FROM ip_pings;",
				);
				const mostActiveUserQuery = env.DB.prepare(
					"SELECT ip_hmac, COUNT(*) as ping_count FROM ip_pings GROUP BY ip_hmac ORDER BY ping_count DESC LIMIT 1;",
				);

				const [
					totalPingsResult,
					totalUniqueUsersResult,
					mostActiveUserResult,
				] = await Promise.all([
					totalPingsQuery.first<{ totalPings: number }>(),
					totalUniqueUsersQuery.first<{ totalUniqueUsers: number }>(),
					mostActiveUserQuery.first<{ ip_hmac: string; ping_count: number } | null>(),
				]);

				const responseData = {
					totalPings: totalPingsResult?.totalPings ?? 0,
					totalUniqueUsers: totalUniqueUsersResult?.totalUniqueUsers ?? 0,
					mostActiveUser: mostActiveUserResult
						? {
								ipHmac: mostActiveUserResult.ip_hmac,
								pingCount: mostActiveUserResult.ping_count,
						  }
						: null,
				};

				return addCors(Response.json(responseData));
			}
			case "/api/pings/grouped": {
				if (request.method !== "GET") {
					return addCors(
						new Response("Method Not Allowed", {
							status: 405,
							headers: { Allow: "GET", "Content-Type": "text/plain" },
						}),
					);
				}

				const url = new URL(request.url);
				const periodParam = url.searchParams.get("period");
				const countTypeParam = url.searchParams.get("countType");

				const parsedPeriod = parseQueryParam(
					periodParam,
					"30d",
					["24h", "7d", "30d", "6month", "all"] as const,
				);
				const parsedCountType = parseQueryParam(
					countTypeParam,
					"unique",
					["unique", "total"] as const,
				);

				const dateRange = getDateRange(parsedPeriod);

				let selectCountSQL;
				if (parsedCountType === "unique") {
					selectCountSQL = "COUNT(DISTINCT ip_hmac) as count";
				} else {
					selectCountSQL = "COUNT(*) as count";
				}

				let sqlQuery = `
					SELECT
						strftime('%Y-%m-%d', ping_timestamp) as day,
						${selectCountSQL}
					FROM ip_pings
				`;
				const bindings: string[] = [];

				if (dateRange) {
					sqlQuery += " WHERE ping_timestamp >= ? AND ping_timestamp <= ?";
					bindings.push(dateRange.startISO, dateRange.endISO);
				}

				sqlQuery += `
					GROUP BY strftime('%Y-%m-%d', ping_timestamp)
					ORDER BY day ASC;
				`;

				try {
					const { results } = await env.DB.prepare(sqlQuery)
						.bind(...bindings)
						.all<{ day: string; count: number }>();
					return addCors(Response.json(results ?? []));
				} catch (e: any) {
					console.error("Error querying grouped pings:", e.message);
					return addCors(
						new Response("Error querying database", { status: 500 }),
					);
				}
			}
			case "/api/pings/unique-activity": {
				if (request.method !== "GET") {
					return addCors(
						new Response("Method Not Allowed", {
							status: 405,
							headers: { Allow: "GET", "Content-Type": "text/plain" },
						}),
					);
				}

				const url = new URL(request.url);
				const pageParam = url.searchParams.get("page");
				const pageSizeParam = url.searchParams.get("pageSize");
				const sortByParam = url.searchParams.get("sortBy");
				const sortOrderParam = url.searchParams.get("sortOrder");

				let page = pageParam ? parseInt(pageParam, 10) : 1;
				if (isNaN(page) || page < 1) page = 1;

				let pageSize = pageSizeParam ? parseInt(pageSizeParam, 10) : 10;
				if (isNaN(pageSize) || pageSize < 1) pageSize = 10;
				if (pageSize > 100) pageSize = 100; // Max page size

				const sortBy = parseQueryParam(
					sortByParam,
					"first_seen",
					["first_seen", "total_pings"] as const,
				);
				const sortOrder = parseQueryParam(
					sortOrderParam,
					"desc",
					["asc", "desc"] as const,
				);

				const offset = (page - 1) * pageSize;

				// Validate sortBy to prevent SQL injection before using in ORDER BY
				const validSortByColumns = {
					first_seen: "first_seen",
					total_pings: "total_pings",
				};
				const orderByColumn = validSortByColumns[sortBy];


				const dataQuerySQL = `
					SELECT
						ip_hmac,
						MIN(ping_timestamp) as first_seen,
						MAX(ping_timestamp) as last_seen,
						COUNT(ping_timestamp) as total_pings
					FROM ip_pings
					GROUP BY ip_hmac
					ORDER BY ${orderByColumn} ${sortOrder.toUpperCase()}
					LIMIT ? OFFSET ?;
				`;

				const countQuerySQL = `
					SELECT COUNT(*) as totalItems
					FROM (SELECT 1 FROM ip_pings GROUP BY ip_hmac);
				`;

				try {
					const dataStatement = env.DB.prepare(dataQuerySQL).bind(pageSize, offset);
					const countStatement = env.DB.prepare(countQuerySQL);

					const [dataResults, countResult] = await Promise.all([
						dataStatement.all<{ ip_hmac: string; first_seen: string; last_seen: string; total_pings: number }>(),
						countStatement.first<{ totalItems: number }>(),
					]);

					const totalItems = countResult?.totalItems ?? 0;
					const totalPages = Math.ceil(totalItems / pageSize);

					return addCors(
						Response.json({
							data: dataResults.results ?? [],
							pagination: {
								totalItems,
								currentPage: page,
								pageSize,
								totalPages,
							},
						}),
					);
				} catch (e: any) {
					console.error("Error querying unique activity:", e.message);
					return addCors(
						new Response("Error querying database", { status: 500 }),
					);
				}
			}
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
