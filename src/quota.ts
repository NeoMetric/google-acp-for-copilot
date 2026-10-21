/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RpcError } from './rpc';

/** A usage limit the server refused a request for. */
export interface QuotaLimit {
	readonly message: string;
	/** When the limit lifts, as epoch milliseconds, when the error said so. */
	readonly resetAt?: number;
}

/** Thrown in place of the server's own error when a request hit a usage limit. */
export class QuotaLimitError extends Error {

	constructor(readonly limit: QuotaLimit, now = Date.now(), options?: { cause?: unknown }) {
		super(
			limit.resetAt !== undefined
				? `Your Antigravity usage limit is reached. It resets ${formatReset(limit.resetAt, now)}.`
				: "Your Antigravity usage limit is reached. Try again later.",
			options,
		);
		this.name = "QuotaLimitError";
	}
}

const QUOTA_WORDS = /quota|rate.?limit|resource.?exhausted|usage limit|limit (?:reached|exceeded)|exhausted your capacity|too many requests|\b429\b/i;
const ISO_TIME = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?/;
const WORDED_DURATION = /(?:resets?|retry|try again|available|refreshes?)\D{0,12}?(?:in|after)\s+((?:\d+\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b\s*,?\s*(?:and\s+)?)+)/i;
const RETRY_SECONDS = /retry_?(?:after|delay)\W{1,4}(\d+(?:\.\d+)?)\s*s?\b/i;

/** Recognises an error that means "a usage limit is spent", and reads the reset time out of it when there is one. */
export function parseQuotaError(error: unknown, now = Date.now()): QuotaLimit | undefined {
	if (!(error instanceof RpcError)) {
		return undefined;
	}
	const text = `${error.message} ${stringify(error.data)}`;
	if (!QUOTA_WORDS.test(text)) {
		return undefined;
	}
	return { message: error.message, resetAt: readResetTime(text, now) };
}

function readResetTime(text: string, now: number): number | undefined {
	const iso = ISO_TIME.exec(text)?.[0];
	if (iso) {
		const time = Date.parse(/(?:Z|[+-]\d{2}:\d{2})$/.test(iso) ? iso : `${iso}Z`);
		if (Number.isFinite(time) && time > now) {
			return time;
		}
	}

	const worded = WORDED_DURATION.exec(text)?.[1];
	if (worded) {
		const duration = durationMs(worded);
		if (duration > 0) {
			return now + duration;
		}
	}

	const seconds = RETRY_SECONDS.exec(text)?.[1];
	return seconds ? now + Math.ceil(Number(seconds) * 1000) : undefined;
}

function durationMs(text: string): number {
	const unit: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 };
	let total = 0;
	for (const [, amount, name] of text.matchAll(/(\d+)\s*([a-z]+)/gi)) {
		total += Number(amount) * (unit[name.toLowerCase()[0]] ?? 0);
	}
	return total;
}

/** "in 4h 12m" for a reset that is ahead, "now" once it has passed. */
export function formatReset(resetAt: number, now = Date.now()): string {
	const remaining = resetAt - now;
	if (remaining <= 0) {
		return "now";
	}
	const minutes = Math.max(1, Math.round(remaining / 60_000));
	const days = Math.floor(minutes / 1440);
	const hours = Math.floor(minutes % 1440 / 60);
	const rest = minutes % 60;
	const parts = days > 0 ? [`${days}d`, `${hours}h`] : hours > 0 ? [`${hours}h`, `${rest}m`] : [`${rest}m`];
	return `in ${parts.join(' ')}`;
}

/** The plan tier the server reported, as one readable string. */
export function describeTier(tier: unknown): string | undefined {
	if (typeof tier === 'string' && tier.trim()) {
		return tier.trim();
	}
	if (tier && typeof tier === 'object') {
		const record = tier as Record<string, unknown>;
		for (const key of ['name', 'displayName', 'display_name', 'id', 'tier']) {
			const value = record[key];
			if (typeof value === 'string' && value.trim()) {
				return value.trim();
			}
		}
	}
	return undefined;
}

function stringify(value: unknown): string {
	if (value === undefined || value === null) {
		return '';
	}
	try {
		return typeof value === 'string' ? value : JSON.stringify(value);
	} catch {
		return '';
	}
}
