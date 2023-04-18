import process from 'node:process';
import { setInterval } from 'node:timers';
import { API } from '@discordjs/core/http-only';
import { REST } from '@discordjs/rest';
import { request } from 'undici';
import { LazyIter } from './LazyIter.js';

const REQUIRED_ENV_VARS = [
	'PARSEABLE_TOKEN',
	'PARSEABLE_URL',
	'SERVICE_NAME',
	'DISCORD_WEBHOOK_ID',
	'DISCORD_WEBHOOK_TOKEN',
] as const;
for (const envVar of REQUIRED_ENV_VARS) {
	if (!(envVar in process.env)) {
		throw new Error(`${envVar} environment variable is not set`);
	}
}

const headers = {
	Authorization: `Basic ${process.env.PARSEABLE_TOKEN}`,
	'Content-Type': 'application/json',
};

const batch: Omit<Log, 'name'>[] = [];

async function ensureStream(): Promise<void> {
	const { statusCode, body } = await request(`${process.env.PARSEABLE_URL!}/api/v1/logstream`, {
		method: 'GET',
		headers,
	});

	if (statusCode !== 200) {
		console.log(await body.json());
		throw new Error('Failed to get log streams');
	}

	const streams = (await body.json()) as { name: string }[];
	if (!streams.some((stream) => stream.name === process.env.SERVICE_NAME)) {
		const createResponse = await request(`${process.env.PARSEABLE_URL!}/api/v1/logstream/${process.env.SERVICE_NAME}`, {
			method: 'PUT',
			headers,
		});

		if (createResponse.statusCode !== 200) {
			console.log(await createResponse.body.text());
			throw new Error('Failed to create log stream');
		}

		// Streams must not be empty before setting up retention
		await handleLog({ datetime: new Date().toISOString(), level: 'info', message: 'Log stream created' });
		await flush();

		const retentionResponse = await request(
			`${process.env.PARSEABLE_URL!}/api/v1/logstream/${process.env.SERVICE_NAME}/retention`,
			{
				method: 'PUT',
				headers,
				body: JSON.stringify([
					{
						description: 'delete after 30 days',
						duration: '30d',
						action: 'delete',
					},
				]),
			},
		);

		if (retentionResponse.statusCode !== 200) {
			console.log(await retentionResponse.body.text());
			throw new Error('Failed to setup log stream retention');
		}
	}
}

await ensureStream();

type LogLevel = 'debug' | 'error' | 'fatal' | 'info' | 'trace' | 'unknown' | 'warn';

const LEVELS_MAP: Record<number, LogLevel> = {
	60: 'fatal',
	50: 'error',
	40: 'warn',
	30: 'info',
	20: 'debug',
	10: 'trace',
};

interface ErrLog {
	message: string;
	stack: string;
	type: string;
}

interface Log {
	datetime: string;
	error?: ErrLog;
	level: LogLevel;
	message?: string;
	name?: string;
}

process.stdin.setEncoding('utf8');

const iter = new LazyIter<string>(process.stdin[Symbol.asyncIterator](), (chunk) => chunk.split('\n'));
const discord = new API(new REST());

function isValidJson(line: string): boolean {
	try {
		JSON.parse(line);
		return true;
	} catch {
		return false;
	}
}

async function handleLog(log: Log & { [K: string]: any }): Promise<void> {
	const { name: setName, ...rest } = log;
	if (setName) {
		await handleLog({
			datetime: new Date().toISOString(),
			level: 'warn',
			message: 'Log has a name field, but that should be handled by the transport alone, ignoring',
			log,
		});
	}

	batch.push(rest);
}

async function handleInvalid(log: unknown, field: string): Promise<void> {
	await handleLog({
		datetime: new Date().toISOString(),
		level: 'warn',
		message: `Invalid log line, missing ${field} field`,
		log,
	});
}

async function handleLine(line: string): Promise<void> {
	try {
		const log = JSON.parse(line) as Record<string, unknown>;
		if (!('time' in log)) {
			await handleInvalid(log, 'time');
			return;
		}

		if (!('level' in log)) {
			await handleInvalid(log, 'level');
			return;
		}

		const { msg, time, err, level, ...rest } = log as {
			[K: string]: unknown;
			err: ErrLog;
			level: number;
			msg: string;
			time: number;
		};

		const final: Log = {
			...rest,
			message: msg,
			error: err,
			datetime: new Date(time).toISOString(),
			level: LEVELS_MAP[level] ?? 'unknown',
		};

		await handleLog(final);
	} catch {
		// Uh-oh, we likely ran into a hard crash. We need to construct our own log object
		const stackParts: string[] = [line];

		let next = await iter.peekAnd((line) => !isValidJson(line));
		while (next !== undefined) {
			stackParts.push(next);
			await iter.next();
			next = await iter.peekAnd((line) => !isValidJson(line));
		}

		if (!stackParts.some((line) => line.toLowerCase().includes('error: '))) {
			return;
		}

		// Sort of replicate the structure we'd get from a "proper" pino error log
		const message = '[unable to infer due to this being a hard crash]';
		const error: ErrLog = {
			type: message,
			message,
			stack: stackParts.join('\n'),
		};

		const log: Log = {
			level: 'fatal',
			datetime: new Date().toISOString(),
			message,
			error,
		};

		await handleLog(log);
	}
}

async function flush(): Promise<void> {
	if (!batch.length) {
		return;
	}

	const body = JSON.stringify(batch);

	const {
		statusCode,
		headers: responseHeaders,
		body: responseBody,
	} = await request(`${process.env.PARSEABLE_URL!}/api/v1/logstream/${process.env.SERVICE_NAME}`, {
		method: 'POST',
		headers,
		body,
	});

	if (statusCode !== 200) {
		const response = responseHeaders['content-type']?.includes('application/json')
			? await responseBody.json().catch(() => null)
			: await responseBody.text().catch(() => null);

		await handleLog({
			datetime: new Date().toISOString(),
			level: 'fatal',
			message: `Failed to send logs to Parseable, got status code ${statusCode}`,
			statusCode,
			response,
		});
	}

	const errors = batch.filter((log) => log.level === 'fatal' || log.level === 'error');
	if (errors.length) {
		try {
			const embeds = errors.map((log) => ({
				title:
					log.level === 'fatal'
						? `Fatal error occured in service ${process.env.SERVICE_NAME}`
						: `Error occured in service ${process.env.SERVICE_NAME}`,
				description: `\`\`\`${log.error?.stack ?? log.message}\`\`\``,
			}));
			// @ts-expect-error - Waiting for next release where the signature is patched and the abort signal isn't required
			await discord.webhooks.execute(process.env.DISCORD_WEBHOOK_ID!, process.env.DISCORD_WEBHOOK_TOKEN!, {
				embeds,
				wait: true,
			});
		} catch (error) {
			const _error = error as Error;

			await handleLog({
				datetime: new Date().toISOString(),
				level: 'warn',
				message: 'Failed to send fatal logs to Discord',
				error: {
					message: _error.message,
					type: _error.name,
					stack: _error.stack!,
				},
			});
		}
	}

	batch.splice(0, batch.length);
}

setInterval(flush, 5_000).unref();

while (!iter.done) {
	try {
		const item = await iter.next();
		await handleLine(item);
	} catch {}
}

// Since the interval is unreffed, the process quits after our while loop is done
// We need to flush the remaining logs before we exit
await flush();
