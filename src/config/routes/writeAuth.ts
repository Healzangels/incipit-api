import crypto from 'crypto'
import { FastifyReply, FastifyRequest } from 'fastify'

import { isIpAllowed, parseEnvArray } from '#config/routes/metrics'

/**
 * Access guard for the DESTRUCTIVE routes (the DELETE endpoints).
 *
 * These were inherited from audnexus — a public, read-mostly API — with no auth,
 * so on a self-hosted instance any client that can reach the port could wipe
 * book/author/chapter records. Unlike the read-only /metrics endpoint (which
 * defaults OPEN when unconfigured), a destructive route defaults CLOSED: with
 * neither a token nor an IP allowlist configured, every delete is refused.
 *
 * To enable deletes, set either:
 *  - DELETE_AUTH_TOKEN — sent by the caller as the `x-delete-token` header, or
 *  - DELETE_ALLOWED_IPS — comma-separated IPs / CIDR ranges.
 * @param {FastifyRequest} request the incoming request
 * @returns {boolean} whether this request may perform a delete
 */
export function isDeleteAllowed(request: FastifyRequest): boolean {
	const authToken = process.env.DELETE_AUTH_TOKEN
	const allowedIps = parseEnvArray(process.env.DELETE_ALLOWED_IPS)

	// Secure by default: a destructive route with no auth configured is disabled.
	if (!authToken && !allowedIps) return false

	// IP allowlist.
	if (allowedIps && allowedIps.length > 0 && isIpAllowed(request, allowedIps)) {
		return true
	}

	// Token (constant-time compare, length-guarded so timingSafeEqual can't throw).
	if (authToken) {
		const requestToken = request.headers['x-delete-token']?.toString()
		if (requestToken) {
			const bufRequest = Buffer.from(requestToken)
			const bufAuth = Buffer.from(authToken)
			if (bufRequest.length === bufAuth.length && crypto.timingSafeEqual(bufRequest, bufAuth)) {
				return true
			}
		}
	}

	return false
}

/**
 * Fastify preHandler that refuses an unauthorized delete with 403. Returning the
 * sent reply halts the route handler so the destructive work never runs.
 * @param {FastifyRequest} request the incoming request
 * @param {FastifyReply} reply the reply
 */
export async function requireDeleteAuth(
	request: FastifyRequest,
	reply: FastifyReply
): Promise<void> {
	if (!isDeleteAllowed(request)) {
		request.log.warn(
			{ ip: request.ip, url: request.url },
			'Refused an unauthorized delete (set DELETE_AUTH_TOKEN or DELETE_ALLOWED_IPS to enable deletes)'
		)
		// Match the route idiom (reply.code + throw) so Fastify halts before the
		// handler runs and its error path serializes the 403.
		reply.code(403)
		throw new Error('Forbidden')
	}
}

/**
 * Log a one-time startup notice when the delete routes are disabled because no
 * auth is configured, so an operator who expects them to work knows why.
 * @param {{ log: { warn: (msg: string) => void } }} fastify the server
 */
export function warnIfDeletesDisabled(fastify: { log: { warn: (msg: string) => void } }): void {
	if (!process.env.DELETE_AUTH_TOKEN && !parseEnvArray(process.env.DELETE_ALLOWED_IPS)) {
		fastify.log.warn(
			'DELETE routes are disabled: no DELETE_AUTH_TOKEN or DELETE_ALLOWED_IPS configured. Set one to enable book/author/chapter deletes.'
		)
	}
}
