// helper functions for the world wide web with Bun

import * as fs from "fs"
import * as path from "path"
import type {
	ServeOptions,
	WebSocketServeOptions,
	SocketAddress,
	ServerWebSocket,
	ServerWebSocketSendStatus,
	WebSocketHandler,
} from "bun"
import * as sqlite from "bun:sqlite"

export const isDev = Boolean(Bun.env["DEV"])

export type Req = {
	method: string,
	headers: Headers,
	url: URL,
	params: Record<string, string>,
	text: () => Promise<string>,
	arrayBuffer: () => Promise<ArrayBuffer>,
	json<T = any>(): Promise<T>,
	formData: () => Promise<FormData>,
	blob: () => Promise<Blob>,
	getIP: () => string | null,
	getCookies: () => Record<string, string>,
}

export type Res = {
	headers: Headers,
	status: number,
	body: null | BodyInit,
	send: (data?: BodyInit | null, opt?: ResOpt) => void,
	sendText: (content: string, opt?: ResOpt) => void,
	sendHTML: (content: string, opt?: ResOpt) => void,
	sendJSON: <T = any>(content: T, opt?: ResOpt) => void,
	sendFile: (path: string, opt?: ResOpt) => void,
	redirect: (location: string, opt?: ResOpt) => void,
	onFinish: (action: () => void) => void,
}

export type ResOpt = {
	headers?: HeadersInit,
	status?: number,
}

export type Ctx = {
	req: Req,
	res: Res,
	next: () => void,
	upgrade: (opts?: ServerUpgradeOpts) => boolean,
}

export type Handler = (ctx: Ctx) => void
export type ErrorHandler = (ctx: Ctx, err: Error) => void
export type NotFoundHandler = (ctx: Ctx) => void

export class Registry<T> extends Map<number, T> {
	private lastID: number = 0
	push(v: T): number {
		const id = this.lastID
		this.set(id, v)
		this.lastID++
		return id
	}
	pushd(v: T): () => void {
		const id = this.push(v)
		return () => this.delete(id)
	}
}

export type Server = {
	use: (handler: Handler) => void,
	error: (handler: ErrorHandler) => void,
	notFound: (action: NotFoundHandler) => void,
    stop: (closeActiveConnections?: boolean) => void,
	hostname: string,
	url: URL,
	port: number,
	ws: {
		clients: Map<string, WebSocket>,
		onMessage: (action: (ws: WebSocket, msg: string | Buffer) => void) => EventController,
		onOpen: (action: (ws: WebSocket) => void) => EventController,
		onClose: (action: (ws: WebSocket) => void) => EventController,
		broadcast: (data: string | Bun.BufferSource, compress?: boolean) => void,
		publish: (
			topic: string,
			data: string | DataView | ArrayBuffer | SharedArrayBuffer,
			compress?: boolean,
		) => ServerWebSocketSendStatus,
	},
}

export type ServerOpts = Omit<ServeOptions, "fetch"> | Omit<WebSocketServeOptions, "fetch">

export type ServerUpgradeOpts<T = undefined> = {
	headers?: HeadersInit,
	data?: T,
}

export type EventController = {
	paused: boolean,
	cancel: () => void
}

export function createEvent<Args extends any[] = any[]>() {

	const actions = new Registry<(...args: Args) => void>()

	function add(action: (...args: Args) => void): EventController {
		let paused = false
		const cancel = actions.pushd((...args: Args) => {
			if (paused) return
			action(...args)
		})
		return {
			get paused() {
				return paused
			},
			set paused(p: boolean) {
				paused = p
			},
			cancel: cancel,
		}
	}
	function addOnce(action: (...args: Args) => void): EventController {
		const ev = add((...args) => {
			ev.cancel()
			action(...args)
		})
		return ev
	}

	const next = () => new Promise((res) => addOnce((...args) => res(args)))
	const trigger = (...args: Args) => actions.forEach((action) => action(...args))
	const numListeners = () => actions.size
	const clear = () => actions.clear()

	return {
		add,
		addOnce,
		next,
		trigger,
		numListeners,
		clear,
	}
}

export type WebSocketData = {
	id: string,
}

// TODO: support arbituary data
export type WebSocket = ServerWebSocket<WebSocketData>

const isPromise = (input: any): input is Promise<any> => {
	return input
		&& typeof input.then === "function"
		&& typeof input.catch === "function"
}

export function createServer(opts: ServerOpts = {}): Server {

	const wsClients = new Map<string, WebSocket>()
	const wsEvents = {
		message: createEvent<[WebSocket, string | Buffer]>(),
		open: createEvent<[WebSocket]>(),
		close: createEvent<[WebSocket]>(),
	}
	const websocket: WebSocketHandler<WebSocketData> = {
		message: (ws, msg) => {
			wsEvents.message.trigger(ws, msg)
		},
		open: (ws) => {
			const id = crypto.randomUUID()
			wsClients.set(id, ws)
			ws.data = {
				id: id,
			}
			wsEvents.open.trigger(ws)
		},
		close: (ws) => {
			wsClients.delete(ws.data.id)
			wsEvents.close.trigger(ws)
		},
	}

	async function fetch(bunReq: Request): Promise<Response> {
		return new Promise((resolve) => {
			let done = false
			const req: Req = {
				method: bunReq.method,
				url: new URL(bunReq.url),
				headers: bunReq.headers,
				params: {},
				text: bunReq.text.bind(bunReq),
				json: bunReq.json.bind(bunReq),
				arrayBuffer: bunReq.arrayBuffer.bind(bunReq),
				formData: bunReq.formData.bind(bunReq),
				blob: bunReq.blob.bind(bunReq),
				getIP: () => {
					let ip = bunReq.headers.get("X-Forwarded-For")?.split(",")[0].trim()
						?? bunServer.requestIP(bunReq)?.address
					if (!ip) return null
					const ipv6Prefix = "::ffff:"
					// ipv4 in ipv6
					if (ip?.startsWith(ipv6Prefix)) {
						ip = ip.substring(ipv6Prefix.length)
					}
					const localhostIPs = new Set([
						"127.0.0.1",
						"::1",
					])
					if (localhostIPs.has(ip)) return null
					return ip
				},
				getCookies: () => {
					const str = bunReq.headers.get("Cookie")
					if (!str) return {}
					const cookies: Record<string, string> = {}
					for (const c of str.split(";")) {
						const [k, v] = c.split("=")
						cookies[k.trim()] = v.trim()
					}
					return cookies
				},
			}
			const onFinishEvents: Array<() => void> = []
			const res: Res = {
				headers: new Headers(),
				status: 200,
				body: null,
				send(body, opt = {}) {
					if (done) return
					this.body = body ?? null
					resolve(new Response(body, {
						headers: {
							...this.headers.toJSON(),
							...(opt.headers ?? {}),
						},
						status: opt.status ?? this.status,
					}))
					done = true
					onFinishEvents.forEach((f) => f())
				},
				sendText(content, opt) {
					this.headers.append("Content-Type", "text/plain; charset=utf-8")
					this.send(content, opt)
				},
				sendHTML(content, opt) {
					this.headers.append("Content-Type", "text/html; charset=utf-8")
					this.send(content, opt)
				},
				sendJSON(content, opt) {
					this.headers.append("Content-Type", "application/json")
					this.send(JSON.stringify(content), opt)
				},
				sendFile(path, opt) {
					if (!isFileSync(path)) return
					const file = Bun.file(path)
					if (file.size === 0) return
					this.headers.append("Content-Type", file.type)
					this.send(file, opt)
				},
				redirect(location: string, opt) {
					this.status = 302
					this.headers.append("Location", location)
					this.send(null, opt)
				},
				onFinish(action) {
					onFinishEvents.push(action)
				},
			}
			const curHandlers = [...handlers]
			function next() {
				if (done) return
				const h = curHandlers.shift()
				const ctx: Ctx = {
					req,
					res,
					next,
					upgrade: (opts) => {
						const success = bunServer.upgrade(bunReq, opts)
						// @ts-ignore
						if (success) resolve(undefined)
						return success
					},
				}
				if (h) {
					try {
						const res = h(ctx)
						if (isPromise(res)) {
							res.catch((e) => {
								if (errHandler) {
									errHandler(ctx, e)
								}
							})
						}
					} catch (e) {
						errHandler(ctx, e as Error)
					}
				} else {
					notFoundHandler(ctx)
				}
			}
			next()
		})
	}

	const bunServer = Bun.serve({
		...opts,
		websocket,
		fetch,
		development: isDev,
	})

	const handlers: Handler[] = []
	const use = (handler: Handler) => handlers.push(handler)
	let errHandler: ErrorHandler = ({ req, res, next }, err) => {
		// TODO: async error doesn't send response in dev mode
		if (isDev) throw err
		console.error(err)
		res.status = 500
		res.sendText(`internal server error`)
	}
	let notFoundHandler: NotFoundHandler = ({ res }) => {
		res.status = 404
		res.sendText("not found")
	}

	return {
		use: use,
		error: (action: ErrorHandler) => errHandler = action,
		notFound: (action: NotFoundHandler) => notFoundHandler = action,
		stop: bunServer.stop.bind(bunServer),
		hostname: bunServer.hostname,
		url: bunServer.url,
		port: bunServer.port,
		ws: {
			clients: wsClients,
			onMessage: (action) => wsEvents.message.add(action),
			onOpen: (action) => wsEvents.open.add(action),
			onClose: (action) => wsEvents.close.add(action),
			publish: bunServer.publish.bind(bunServer),
			// TODO: option to exclude self
			broadcast: (data: string | Bun.BufferSource, compress?: boolean) => {
				wsClients.forEach((client) => {
					client.send(data, compress)
				})
			},
		},
	}
}

type Func = (...args: any[]) => any

export function overload2<A extends Func, B extends Func>(fn1: A, fn2: B): A & B {
	return ((...args) => {
		const al = args.length
		if (al === fn1.length) return fn1(...args)
		if (al === fn2.length) return fn2(...args)
	}) as A & B
}

export function overload3<
	A extends Func,
	B extends Func,
	C extends Func,
>(fn1: A, fn2: B, fn3: C): A & B & C {
	return ((...args) => {
		const al = args.length
		if (al === fn1.length) return fn1(...args)
		if (al === fn2.length) return fn2(...args)
		if (al === fn3.length) return fn3(...args)
	}) as A & B & C
}

export function overload4<
	A extends Func,
	B extends Func,
	C extends Func,
	D extends Func,
>(fn1: A, fn2: B, fn3: C, fn4: D): A & B & C & D {
	return ((...args) => {
		const al = args.length
		if (al === fn1.length) return fn1(...args)
		if (al === fn2.length) return fn2(...args)
		if (al === fn3.length) return fn3(...args)
		if (al === fn4.length) return fn4(...args)
	}) as A & B & C & D
}

export const route = overload2((pat: string, handler: Handler): Handler => {
	return (ctx) => {
		const match = matchPath(pat, decodeURI(ctx.req.url.pathname))
		if (match) {
			ctx.req.params = match
			return handler(ctx)
		} else {
			ctx.next()
		}
	}
}, (method: string, pat: string, handler: Handler): Handler => {
	return (ctx) => {
		if (ctx.req.method.toLowerCase() === method.toLowerCase()) {
			return route(pat, handler)(ctx)
		} else {
			ctx.next()
		}
	}
})

export function files(route = "", root = ""): Handler {
	return ({ req, res, next }) => {
		route = trimSlashes(route)
		const pathname = trimSlashes(decodeURI(req.url.pathname))
		if (!pathname.startsWith(route)) return next()
		const baseDir = "./" + trimSlashes(root)
		const relativeURLPath = pathname.replace(new RegExp(`^${route}/?`), "")
		const p = path.join(baseDir, relativeURLPath)
		return res.sendFile(p)
	}
}

export function dir(route = "", root = ""): Handler {
	return ({ req, res, next }) => {
		route = trimSlashes(route)
		const pathname = trimSlashes(decodeURI(req.url.pathname))
		if (!pathname.startsWith(route)) return next()
		const baseDir = "./" + trimSlashes(root)
		const relativeURLPath = pathname.replace(new RegExp(`^${route}/?`), "")
		const p = path.join(baseDir, relativeURLPath)
		if (isFileSync(p)) {
			return res.sendFile(p)
		} else if (isDirSync(p)) {
			const entries = fs.readdirSync(p)
				.filter((entry) => !entry.startsWith("."))
				.sort((a, b) => a > b ? -1 : 1)
				.sort((a, b) => path.extname(a) > path.extname(b) ? 1 : -1)
			const files = []
			const dirs = []
			for (const entry of entries) {
				const pp = path.join(p, entry)
				if (isDirSync(pp)) {
					dirs.push(entry)
				} else if (isFileSync(pp)) {
					files.push(entry)
				}
			}
			const isRoot = relativeURLPath === ""
			return res.sendHTML("<!DOCTYPE html>" + h("html", { lang: "en" }, [
				h("head", {}, [
					h("title", {}, decodeURI(req.url.pathname)),
					h("style", {}, css({
						"*": {
							"margin": "0",
							"padding": "0",
							"box-sizing": "border-box",
						},
						"body": {
							"padding": "16px",
							"font-size": "16px",
							"font-family": "Monospace",
						},
						"li": {
							"list-style": "none",
						},
						"a": {
							"color": "blue",
							"text-decoration": "none",
							":hover": {
								"background": "blue",
								"color": "white",
							},
						},
					})),
				]),
				h("body", {}, [
					h("ul", {}, [
						...(isRoot ? [] : [
							h("a", { href: `/${parentPath(pathname)}`, }, ".."),
						]),
						...dirs.map((dir) => h("li", {}, [
							h("a", { href: `/${pathname}/${dir}`, }, dir + "/"),
						])),
						...files.map((file) => h("li", {}, [
							h("a", { href: `/${pathname}/${file}`, }, file),
						])),
					]),
				]),
			]))
		}
	}
}

export type RateLimiterOpts = {
	time: number,
	limit: number,
	handler: Handler,
}

export function rateLimiter(opts: RateLimiterOpts): Handler {
	const reqCounter: Record<string, number> = {}
	return (ctx) => {
		const ip = ctx.req.getIP()
		if (!ip) return ctx.next()
		if (!(ip in reqCounter)) {
			reqCounter[ip] = 0
		}
		reqCounter[ip] += 1
		setTimeout(() => {
			reqCounter[ip] -= 1
			if (reqCounter[ip] === 0) {
				delete reqCounter[ip]
			}
		}, opts.time * 1000)
		if (reqCounter[ip] > opts.limit) {
			ctx.res.status = 429
			return opts.handler(ctx)
		}
		return ctx.next()
	}
}

export function toHTTPDate(d: Date) {
	return d.toUTCString()
}

export type LoggerOpts = {
	file?: string,
	stdio?: boolean,
	filter?: (req: Req, res: Res) => boolean,
}

export function toReadableSize(byteSize: number) {
	const toFixed = (n: number) => Number(n.toFixed(2))
	if (byteSize >= Math.pow(1024, 4)) {
		return `${toFixed(byteSize / 1024 / 1024 / 1024 / 1024)}tb`
	} else if (byteSize >= Math.pow(1024, 3)) {
		return `${toFixed(byteSize / 1024 / 1024 / 1024)}gb`
	} else if (byteSize >= Math.pow(1024, 2)) {
		return `${toFixed(byteSize / 1024 / 1024)}mb`
	} else if (byteSize >= Math.pow(1024, 1)) {
		return `${toFixed(byteSize / 1024)}kb`
	} else {
		return `${byteSize}b`
	}
}

// TODO: is there a way to get bun calculated Content-Length result?
// TODO: ReadableStream?
export function getBodySize(body: BodyInit) {
	if (typeof body === "string") {
		return Buffer.byteLength(body)
	} else if (body instanceof Blob) {
		return body.size
	} else if (body instanceof ArrayBuffer || "byteLength" in body) {
		return body.byteLength
	} else if (body instanceof URLSearchParams) {
		return Buffer.byteLength(body.toString())
	} else if (body instanceof FormData) {
		let size = 0
		body.forEach((v, k) => {
			if (typeof v === "string") {
				size += Buffer.byteLength(v)
			} else {
				size += v.size
			}
		})
		return size
	}
}

type LoggerMsgOpts = {
	color?: boolean,
}

// TODO: log only err / info to file / stdio?
// TODO: can there be a onStart() to record time
// TODO: catch error
export function logger(opts: LoggerOpts = {}): Handler {
	return ({ req, res, next }) => {
		if (opts.filter) {
			if (!opts.filter(req, res)) {
				return next()
			}
		}
		const genMsg = (msgOpts: LoggerMsgOpts = {}) => {
			const a = mapValues(ansi, (v) => {
				if (msgOpts.color) {
					return v
				} else {
					if (typeof v === "string") {
						return ""
					} else if (typeof v === "function") {
						return () => ""
					}
					return v
				}
			})
			const endTime = new Date()
			const msg = []
			const year = endTime.getUTCFullYear().toString().padStart(4, "0")
			const month = (endTime.getUTCMonth() + 1).toString().padStart(2, "0")
			const date = endTime.getUTCDate().toString().padStart(2, "0")
			const hour = endTime.getUTCHours().toString().padStart(2, "0")
			const minute = endTime.getUTCMinutes().toString().padStart(2, "0")
			const seconds = endTime.getUTCSeconds().toString().padStart(2, "0")
			// TODO: why this turns dim red for 4xx and 5xx responses?
			msg.push(`${a.dim}[${year}-${month}-${date} ${hour}:${minute}:${seconds}]${a.reset}`)
			const statusClor = {
				"1": a.yellow,
				"2": a.green,
				"3": a.blue,
				"4": a.red,
				"5": a.red,
			}[res.status.toString()[0]] ?? a.yellow
			msg.push(`${a.bold}${statusClor}${res.status}${a.reset}`)
			msg.push(req.method)
			msg.push(req.url.pathname)
			msg.push(`${a.dim}${endTime.getTime() - startTime.getTime()}ms${a.reset}`)
			const size = res.body ? getBodySize(res.body) : 0
			if (size) {
				msg.push(`${a.dim}${toReadableSize(size)}${a.reset}`)
			}
			return msg.join(" ")
		}
		const startTime = new Date()
		res.onFinish(() => {
			if (opts.stdio !== false) {
				const log = {
					"1": console.log,
					"2": console.log,
					"3": console.log,
					"4": console.error,
					"5": console.error,
				}[res.status.toString()[0]] ?? console.log
				log(genMsg({ color: true }))
			}
			if (opts.file) {
				fs.appendFileSync(opts.file, genMsg({ color: false }) + "\n", "utf8")
			}
		})
		return next()
	}
}

const trimSlashes = (str: string) => str.replace(/\/*$/, "").replace(/^\/*/, "")
const parentPath = (p: string, sep = "/") => p.split(sep).slice(0, -1).join(sep)

export function matchPath(pat: string, url: string): Record<string, string> | null {

	pat = pat.replace(/\/$/, "")
	url = url.replace(/\/$/, "")

	if (pat === url) return {}

	const vars = pat.match(/:[^\/]+/g) || []
	let regStr = pat

	for (const v of vars) {
		const name = v.substring(1)
		regStr = regStr.replace(v, `(?<${name}>[^\/]+)`)
	}

	regStr = "^" + regStr + "$"

	const reg = new RegExp(regStr)
	const matches = reg.exec(url)

	if (matches) {
		return { ...matches.groups }
	} else {
		return null
	}

}

export type ColumnType =
	| "INTEGER"
	| "TEXT"
	| "BOOLEAN"
	| "REAL"
	| "BLOB"

export type ColumnDef = {
	type: ColumnType,
	primaryKey?: boolean,
	autoIncrement?: boolean,
	allowNull?: boolean,
	unique?: boolean,
	default?: string | number,
	index?: boolean,
	fts?: boolean,
	reference?: {
		table: string,
		column: string,
	},
}

export type CreateDatabaseOpts = {
	wal?: boolean,
}

export type WhereOp =
	| "="
	| ">"
	| "<"
	| ">="
	| "<="
	| "!="
	| "BETWEEN"
	| "LIKE"
	| "IN"
	| "NOT BETWEEN"
	| "NOT LIKE"
	| "NOT IN"

export type WhereOpSingle =
	| "IS NULL"
	| "IS NOT NULL"

export type WhereValue =
	| string
	| { value: string, op: WhereOp }
	| { op: WhereOpSingle }

export type DBVars = Record<string, string | number | boolean | Uint8Array>
export type DBData = Record<string, string | number | boolean | Uint8Array>
export type WhereCondition = Record<string, WhereValue>
export type OrderCondition = {
	columns: string[],
	desc?: boolean,
}
export type LimitCondition = number

export type SelectOpts = {
	columns?: "*" | ColumnName[],
	distinct?: boolean,
	where?: WhereCondition,
	order?: OrderCondition,
	limit?: LimitCondition,
	join?: JoinTable<any>[],
}

export type ColumnName = string | {
	name: string,
	as: string,
}

export type JoinType =
	| "INNER"
	| "LEFT"
	| "RIGHT"
	| "FULL"

export type JoinTable<D> = {
	table: Table<D>,
	columns?: "*" | ColumnName[],
	on: {
		column: string,
		matchTable: Table<any>,
		matchColumn: string,
	},
	where?: WhereCondition,
	order?: OrderCondition,
	join?: JoinType,
}

export type TableSchema = Record<string, ColumnDef>

export type Table<D = DBData> = {
	name: string,
	select: <D2 = D>(opts?: SelectOpts) => D2[],
	insert: (data: D) => void,
	update: (data: Partial<D>, where: WhereCondition) => void,
	delete: (where: WhereCondition) => void,
	find: <D2 = D>(where: WhereCondition) => D2,
	findAll: <D2 = D>(where: WhereCondition) => D2[],
	count: (where?: WhereCondition) => number,
	search: (text: string) => D[],
	schema: TableSchema,
}

export type TableOpts<D> = {
	timeCreated?: boolean,
	timeUpdated?: boolean,
	paranoid?: boolean,
	initData?: D[],
}

type TableData<D extends DBData, O extends TableOpts<D>> =
	(O extends { timeCreated: true } ? D & { time_created?: string } : D)
	& (O extends { timeUpdated: true } ? D & { time_updated?: string } : D)
	& (O extends { paranoid: true } ? D & { time_deleted?: string } : D)

// https://discord.com/channels/508357248330760243/1203901900844572723
// typescript has no partial type inference...
export type Database = {
	table: <D extends DBData, O extends TableOpts<D> = TableOpts<D>>(
		name: string,
		schema: TableSchema,
		opts?: O,
	) => Table<TableData<D, O>>,
	transaction: (action: () => void) => void,
	close: () => void,
    serialize: (name?: string) => Buffer,
}

// TODO: support views
// TODO: builtin cache system
export function createDatabase(dbname: string, opts: CreateDatabaseOpts = {}): Database {

	const bdb = new sqlite.Database(dbname)
	const queries: Record<string, sqlite.Statement> = {}

	if (opts.wal) {
		bdb.run("PRAGMA journal_mode = WAL;")
	}

	function compile(sql: string) {
		sql = sql.trim()
		if (!queries[sql]) {
			queries[sql] = bdb.query(sql)
		}
		return queries[sql]
	}

	function genColumnNameSQL(columns: "*" | ColumnName[] = "*") {
		if (!columns || columns === "*") return "*"
		return columns.map((c) => {
			if (typeof c === "string") return c
			if (c.as) return `${c.name} AS ${c.as}`
		}).join(",")
	}

	// TODO: support OR
	function genWhereSQL(where: WhereCondition, vars: DBVars) {
		return `WHERE ${Object.entries(where).map(([k, v]) => {
			if (typeof v === "object") {
				if ("value" in v) {
					vars[`$where_${k}`] = v.value
					return `${k} ${v.op} $where_${k}`
				} else {
					return `${k} ${v.op}`
				}
			} else {
				vars[`$where_${k}`] = v
				return `${k} = $where_${k}`
			}
		}).join(" AND ")}`
	}

	function genOrderSQL(order: OrderCondition) {
		return `ORDER BY ${order.columns.join(", ")}${order.desc ? " DESC" : ""}`
	}

	function genLimitSQL(limit: LimitCondition, vars: DBVars) {
		vars["$limit"] = limit
		return `LIMIT $limit`
	}

	// TODO: support multiple values
	function genValuesSQL(data: DBData, vars: DBVars) {
		return `VALUES (${Object.entries(data).map(([k, v]) => {
			vars[`$value_${k}`] = v
			return `$value_${k}`
		}).join(", ")})`
	}

	const specialVars = new Set([
		"CURRENT_TIMESTAMP",
	])

	function genSetSQL(data: DBData, vars: DBVars) {
		return `SET ${Object.entries(data).map(([k, v]) => {
			if (typeof v === "string" && specialVars.has(v)) {
				return `${k} = ${v}`
			} else {
				vars[`$set_${k}`] = v
				return `${k} = $set_${k}`
			}
		}).join(", ")}`
	}

	function genColumnSQL(name: string, opts: ColumnDef) {
		let code = name + " " + opts.type
		if (opts.primaryKey) code += " PRIMARY KEY"
		if (opts.autoIncrement) code += " AUTOINCREMENT"
		if (!opts.allowNull) code += " NOT NULL"
		if (opts.unique) code += " UNIQUE"
		if (opts.default !== undefined) code += ` DEFAULT ${opts.default}`
		if (opts.reference) code += ` REFERENCES ${opts.reference.table}(${opts.reference.column})`
		return code
	}

	function genColumnsSQL(input: Record<string, ColumnDef>) {
		return Object.entries(input)
			.map(([name, opts]) => "    " + genColumnSQL(name, opts))
			.join(",\n")
	}

	function transaction(action: () => void) {
		return bdb.transaction(action)()
	}

	function run(sql: string) {
		bdb.run(sql.trim())
	}

	function table<D extends Record<string, any>>(
		tableName: string,
		schema: TableSchema,
		topts: TableOpts<D> = {}
	): Table<D> {

		if (tableName.endsWith("_fts")) {
			throw new Error("Cannot manually operate a fts table")
		}

		const boolKeys: string[] = []

		for (const k in schema) {
			const t = schema[k].type
			if (t === "BOOLEAN") {
				boolKeys.push(k)
			}
		}

		const needsTransform = boolKeys.length > 0

		function transformItem(item: any): D {
			if (!needsTransform) return item;
			for (const k of boolKeys) {
				item[k] = Boolean(item[k])
			}
			return item
		}

		function transformItems(items: any[]): any[] {
			if (!needsTransform) return items;
			return items.map(transformItem)
		}

		const exists = compile(`SELECT name FROM sqlite_master WHERE type='table' AND name='${tableName}'`).get()

		if (exists) {
			// TODO: auto migration?
		} else {

			run(`
CREATE TABLE ${tableName} (
${genColumnsSQL({
...schema,
...(topts.timeCreated ? {
	"time_created": { type: "TEXT", default: "CURRENT_TIMESTAMP" },
} : {}),
...(topts.timeUpdated ? {
	"time_updated": { type: "TEXT", default: "CURRENT_TIMESTAMP" },
} : {}),
...(topts.paranoid ? {
	"time_deleted": { type: "TEXT", allowNull: true },
} : {}),
})}
)
			`)
			const pks = []
			const fts = []
			for (const colName in schema) {
				const config = schema[colName]
				if (config.primaryKey) {
					pks.push(colName)
				}
				if (config.index) {
					run(`
CREATE INDEX idx_${tableName}_${colName} ON ${tableName}(${colName})
					`)
				}
				if (config.fts) {
					fts.push(colName)
				}
			}
			if (topts.timeUpdated) {
				if (pks.length === 0) {
					throw new Error("time updated requires primary key")
				}
				run(`
CREATE TRIGGER trigger_${tableName}_time_updated
AFTER UPDATE ON ${tableName}
BEGIN
	UPDATE ${tableName}
	SET time_updated = CURRENT_TIMESTAMP
	WHERE ${pks.map((pk) => `${pk} = NEW.${pk}`).join(" AND ")};
END
				`)
			}
			if (fts.length > 0) {
				// TODO: content / content_rowid?
				run(`
CREATE VIRTUAL TABLE ${tableName}_fts USING fts5 (${[...pks, ...fts].join(", ")})
			`)
			run(`
CREATE TRIGGER trigger_${tableName}_fts_insert
AFTER INSERT ON ${tableName}
BEGIN
	INSERT INTO ${tableName}_fts (${[...pks, ...fts].join(", ")})
	VALUES (${[...pks, ...fts].map((c) => `NEW.${c}`).join(", ")});
END
				`)
				run(`
CREATE TRIGGER trigger_${tableName}_fts_update
AFTER UPDATE ON ${tableName}
BEGIN
	UPDATE ${tableName}_fts
	SET ${fts.map((c) => `${c} = NEW.${c}`).join(", ")}
	WHERE ${pks.map((pk) => `${pk} = NEW.${pk}`).join(" AND ")};
END
				`)
				run(`
CREATE TRIGGER trigger_${tableName}_fts_delete
AFTER DELETE ON ${tableName}
BEGIN
	DELETE FROM ${tableName}_fts
	WHERE ${pks.map((pk) => `${pk} = OLD.${pk}`).join(" AND ")};
END
				`)
			}

			if (topts.initData) {
				topts.initData.forEach(insert)
			}

		}

		// TODO: transform types?
		function select<D2 = D>(opts: SelectOpts = {}): D2[] {
			const vars = {}
			if (topts.paranoid) {
				opts.where = {
					...(opts.where ?? {}),
					"time_deleted": { op: "IS NULL" },
				}
			}
			if (opts.join) {
				// TODO: support where from join tables
				const colNames = (t: string, cols: ColumnName[] | "*" = "*") => {
					const c = cols === "*" ? ["*"] : cols
					return c
						.filter((name) => name)
						.map((c) => {
							if (typeof c === "string") {
								return `${t}.${c}`
							} else {
								return `${t}.${c.name} AS ${c.as}`
							}
						})
						.join(", ")
				}
				const items = compile(`
SELECT${opts.distinct ? " DISTINCT" : ""} ${colNames(tableName, opts.columns)}, ${opts.join.map((j) => colNames(j.table.name, j.columns)).join(", ")}
FROM ${tableName}
${opts.join.map((j) => `${j.join ? j.join.toUpperCase() + " " : ""}JOIN ${j.table.name} ON ${j.table.name}.${j.on.column} = ${j.on.matchTable.name}.${j.on.matchColumn}`).join("\n")}
${opts.where ? genWhereSQL(opts.where, vars) : ""}
				`).all(vars) ?? []
				return items as D2[]
			}
			const items = compile(`
SELECT${opts.distinct ? " DISTINCT" : ""} ${genColumnNameSQL(opts.columns)}
FROM ${tableName}
${opts.where ? genWhereSQL(opts.where, vars) : ""}
${opts.order ? genOrderSQL(opts.order) : ""}
${opts.limit ? genLimitSQL(opts.limit, vars) : ""}
			`).all(vars) ?? []
			return transformItems(items) as D2[]
		}

		function count(where?: WhereCondition) {
			const vars = {}
			const sql = `SELECT COUNT(*) FROM ${tableName} ${where ? genWhereSQL(where, vars) : ""}`
			// @ts-ignore
			return Number(compile(sql).all(vars)[0]["COUNT(*)"])
		}

		function findAll<D2 = D>(where: WhereCondition): D2[] {
			return select({
				where: where,
			})
		}

		function find<D2 = D>(where: WhereCondition): D2 {
			return select<D2>({
				where: where,
				limit: 1,
			})[0]
		}

		// TODO: join
		function search(text: string) {
			const sql = `SELECT * FROM ${tableName}_fts WHERE ${tableName}_fts MATCH $query ORDER BY rank`
			return compile(sql).all({
				"$query": text,
			}) as D[] ?? []
		}

		function insert(data: D) {
			if (!data) {
				throw new Error("Cannot INSERT into database without table / data")
			}
			const vars = {}
			compile(`
INSERT INTO ${tableName} (${Object.keys(data).join(", ")})
${genValuesSQL(data, vars)}
			`).run(vars)
		}

		function update(data: Partial<D>, where: WhereCondition) {
			const vars = {}
			const keys = Object.keys(data)
			compile(`
UPDATE ${tableName}
${genSetSQL(data as DBData, vars)}
${genWhereSQL(where, vars)}
			`).run(vars)
		}

		function remove(where: WhereCondition) {
			const vars = {}
			if (topts.paranoid) {
				// @ts-ignore
				update({
					"time_deleted": "CURRENT_TIMESTAMP",
				}, where)
			} else {
				compile(`
DELETE FROM ${tableName}
${genWhereSQL(where, vars)}
				`).run(vars)
			}
		}

		return {
			name: tableName,
			select,
			find,
			findAll,
			count,
			update,
			insert,
			search,
			delete: remove,
			schema,
		}

	}

	return {
		table,
		transaction,
		close: bdb.close,
		serialize: bdb.serialize,
	}

}

export function trydo<T>(action: () => T, def: T) {
	try {
		return action()
	} catch {
		return def
	}
}

export function isFileSync(path: string) {
	return trydo(() => fs.statSync(path).isFile(), false)
}

export function isDirSync(path: string) {
	return trydo(() => fs.statSync(path).isDirectory(), false)
}

export type ResponseOpts = {
	status?: number,
	headers?: Record<string, string>,
}

export function kvList(props: Record<string, string | boolean | number>) {
	return Object.entries(props)
		.filter(([k, v]) => v)
		.map(([k, v]) => v === true ? k : `${k}=${v}`)
		.join("; ")
}

export async function getReqData(req: Request) {
	const ty = req.headers.get("Content-Type")
	if (
		ty?.startsWith("application/x-www-form-urlencoded")
		|| ty?.startsWith("multipart/form-data")
	) {
		const formData = await req.formData()
		const json: any = {}
		formData.forEach((v, k) => json[k] = v)
		return json
	} else {
		return await req.json()
	}
}

export function formToJSON(form: FormData) {
	const json: any = {}
	form.forEach((v, k) => json[k] = v)
	return json
}

export function getFormText(form: FormData, key: string): string | undefined {
	const t = form.get(key)
	if (typeof t === "string") {
		return t
	}
}

export function getFormBlob(form: FormData, key: string): Blob | undefined {
	const b = form.get(key)
	if (b && b instanceof Blob && b.size > 0) {
		return b
	}
}

export async function getFormBlobData(form: FormData, key: string) {
	const b = getFormBlob(form, key)
	if (b) {
		return new Uint8Array(await b.arrayBuffer())
	}
}

export function getBasicAuth(req: Req): [string, string] | void {
	const auth = req.headers.get("Authorization")
	if (!auth) return
	const [ scheme, cred ] = auth.split(" ")
	if (scheme.toLowerCase() !== "basic") return
	if (!cred) return
	const [ user, pass ] = atob(cred).split(":")
	return [ user, pass ]
}

export function getBearerAuth(req: Req): string | void {
	const auth = req.headers.get("Authorization")
	if (!auth) return
	const [ scheme, cred ] = auth.split(" ")
	if (scheme.toLowerCase() !== "bearer") return
	return cred
}

export type HTMLChild = string | number | undefined | null
export type HTMLChildren = HTMLChild | HTMLChild[]

// html text builder
export function h(
	tag: string,
	attrs: Record<string, any>,
	children?: HTMLChildren
) {

	let html = `<${tag}`

	for (const k in attrs) {
		let v = attrs[k]
		switch (typeof v) {
			case "boolean":
				if (v === true) {
					html += ` ${k}`
				}
				break
			case "string":
				html += ` ${k}="${Bun.escapeHTML(v)}"`
				break
			case "number":
				html += ` ${k}=${v}`
				break
			case "object":
				const value = Array.isArray(v) ? v.join(" ") : style(v)
				html += ` ${k}="${Bun.escapeHTML(value)}"`
				break
		}
	}

	html += ">"

	if (typeof(children) === "string" || typeof(children) === "number") {
		html += children
	} else if (Array.isArray(children)) {
		for (const child of children) {
			if (!child) continue
			if (Array.isArray(child)) {
				html += h("div", {}, child)
			} else {
				html += child
			}
		}
	}

	if (children !== undefined && children !== null) {
		html += `</${tag}>`
	}

	return html

}

export function style(sheet: StyleSheet) {
	let style = ""
	for (const prop in sheet) {
		style += `${prop}: ${sheet[prop]};`
	}
	return style
}

export type StyleSheet = Record<string, string | number>

type StyleSheetRecursive = {
	[name: string]: string | number | StyleSheetRecursive,
}

// TODO: fix
// https://www.typescriptlang.org/docs/handbook/2/objects.html#index-signatures
export type CSS = {
	[name: string]: StyleSheetRecursive,
} & {
	"@keyframes"?: {
		[name: string]: Record<string, StyleSheet>,
	},
} & {
	"@font-face"?: StyleSheet[],
}

export type CSSOpts = {
	readable?: boolean,
}

// sass-like css preprocessor
export function css(list: CSS, opts: CSSOpts = {}) {

	const nl = opts.readable ? "\n" : ""
	const sp = opts.readable ? " " : ""
	let lv = 0
	const id = () => opts.readable ? " ".repeat(lv * 2) : ""

	function handleSheet(sheet: StyleSheet) {
		let code = "{" + nl
		lv++
		for (const prop in sheet) {
			code += id() + `${prop}:${sp}${sheet[prop]};${nl}`
		}
		lv--
		code += id() + "}" + nl
		return code
	}

	function handleSheetRecursive(sel: string, sheet: StyleSheetRecursive) {
		let code = id() + sel + sp + "{" + nl
		lv++
		let post = ""
		for (const key in sheet) {
			// media
			if (key === "@media") {
				const val = sheet[key] as Record<string, StyleSheet>
				for (const cond in val) {
					post += "@media " + cond + sp + "{" + nl
					post += id() + sel + sp + handleSheet(val[cond])
					post += "}" + nl
				}
			// pseudo class
			} else if (key[0] === ":") {
				lv--
				post += handleSheetRecursive(sel + key, sheet[key] as StyleSheetRecursive)
				lv++
			// self
			} else if (key[0] === "&") {
				lv--
				post += handleSheetRecursive(sel + key.substring(1), sheet[key] as StyleSheetRecursive)
				lv++
			// nesting child
			} else if (typeof sheet[key] === "object") {
				lv--
				post += handleSheetRecursive(sel + " " + key, sheet[key] as StyleSheetRecursive)
				lv++
			} else if (typeof sheet[key] === "string" || typeof sheet[key] === "number") {
				code += id() + `${key}:${sp}${sheet[key]};${nl}`
			}
		}
		lv--
		code += id() + "}" + nl + post
		return code
	}

	let code = ""

	// deal with @keyframes
	for (const sel in list) {
		if (sel === "@keyframes") {
			const sheet = list[sel] as CSS["@keyframes"] ?? {}
			for (const name in sheet) {
				const map = sheet[name]
				code += `@keyframes ${name} {` + nl
				lv++
				for (const time in map) {
					code += id() + time + " " + handleSheet(map[time])
				}
				lv--
				code += "}" + nl
			}
		} else if (sel === "@font-face") {
			const fonts = list[sel] as CSS["@font-face"] ?? []
			for (const font of fonts) {
				code += "@font-face " + handleSheet(font)
			}
		} else {
			code += handleSheetRecursive(sel, list[sel] as StyleSheetRecursive)
		}
	}

	return code

}

function mapKeys<D>(obj: Record<string, D>, mapFn: (k: string) => string) {
	return Object.keys(obj).reduce((result: Record<string, D>, key) => {
		result[mapFn(key)] = obj[key]
		return result
	}, {})
}

function mapValues<A, B>(obj: Record<string, A>, mapFn: (v: A) => B) {
	return Object.keys(obj).reduce((result: Record<string, B>, key) => {
		result[key] = mapFn(obj[key])
		return result
	}, {})
}

export type CSSLibOpts = {
	breakpoints?: Record<string, number>,
}

// TODO: a way to only generate used classes, record in h()?
// TODO: deal with pseudos like :hover
export function csslib(opt: CSSLibOpts = {}) {

	// tailwind-like css helpers
	const base: Record<string, Record<string, string | number>> = {
		".vstack": { "display": "flex", "flex-direction": "column" },
		".hstack": { "display": "flex", "flex-direction": "row" },
		".vstack-reverse": { "display": "flex", "flex-direction": "column-reverse" },
		".hstack-reverse": { "display": "flex", "flex-direction": "row-reverse" },
		".stretch-x": { "width": "100%" },
		".stretch-y": { "height": "100%" },
		".bold": { "font-weight": "bold" },
		".italic": { "font-style": "italic" },
		".underline": { "font-decoration": "underline" },
		".center": { "align-items": "center", "justify-content": "center" },
		".align-start": { "align-items": "flex-start" },
		".align-end": { "align-items": "flex-end" },
		".align-center": { "align-items": "center" },
		".align-stretch": { "align-items": "stretch" },
		".align-baseline": { "align-items": "baseline" },
		".justify-start": { "justify-content": "flex-start" },
		".justify-end": { "justify-content": "flex-end" },
		".justify-center": { "justify-content": "center" },
		".justify-between": { "justify-content": "space-between" },
		".justify-around": { "justify-content": "space-around" },
		".justify-evenly": { "justify-content": "space-evenly" },
		".align-self-start": { "align-items": "flex-start" },
		".align-self-end": { "align-self": "flex-end" },
		".align-self-center": { "align-self": "center" },
		".align-self-stretch": { "align-self": "stretch" },
		".align-self-baseline": { "align-self": "baseline" },
		".text-center": { "text-align": "center" },
		".text-left": { "text-align": "left" },
		".text-right": { "text-align": "right" },
		".wrap": { "flex-wrap": "wrap" },
		".wrap-reverse": { "flex-wrap": "wrap-reverse" },
		".nowrap": { "flex-wrap": "no-wrap" },
	}

	for (let i = 1; i <= 8; i++) {
		base[`.grow-${i}}`] = { "flex-grow": i }
		base[`.shrink-${i}}`] = { "flex-shrink": i }
		base[`.flex-${i}}`] = { "flex-grow": i, "flex-shrink": i }
	}

	const spaces = [2, 4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 96, 128]

	for (const s of spaces) {
		base[`.g${s}`] = { "gap": `${s}px` }
		base[`.p${s}`] = { "padding": `${s}px` }
		base[`.px${s}`] = { "padding-left": `${s}px`, "padding-right": `${s}px` }
		base[`.py${s}`] = { "padding-top": `${s}px`, "padding-bottom": `${s}px` }
		base[`.m${s}`] = { "margin": `${s}px` }
		base[`.mx${s}`] = { "margin-left": `${s}px`, "margin-right": `${s}px` }
		base[`.my${s}`] = { "margin-top": `${s}px`, "margin-bottom": `${s}px` }
		base[`.f${s}`] = { "font-size": `${s}px` }
		base[`.r${s}`] = { "border-radius": `${s}px` }
	}

	const compileStyles = (sheet: Record<string, StyleSheet>) => {
		let css = ""
		for (const sel in sheet) {
			css += `${sel} { ${style(sheet[sel])} } `
		}
		return css
	}

	let css = compileStyles(base)
	const breakpoints = opt.breakpoints ?? {}

	for (const bp in breakpoints) {
		css += `@media (max-width: ${breakpoints[bp]}px) {`
		css += compileStyles(mapKeys(base, (sel) => `.${bp}:${sel.substring(1)}`))
		css += `}`
	}

	return css

}

// TODO: not global?
const buildCache: Record<string, string> = {}

// TODO: better error handling?
export async function js(file: string) {
	if (!isDev) {
		if (buildCache[file]) {
			return Promise.resolve(buildCache[file])
		}
	}
	const res = await Bun.build({
		entrypoints: [file],
		minify: !isDev,
		sourcemap: isDev ? "inline" : "none",
		target: "browser",
	})
	if (res.success) {
		if (res.outputs.length !== 1) {
			throw new Error(`Expected 1 output, found ${res.outputs.length}`)
		}
		const code = await res.outputs[0].text()
		if (!isDev) {
			buildCache[file] = code
		}
		return code
	} else {
		console.log(res.logs[0])
		throw new Error("Failed to build js")
	}
}

export function jsData(name: string, data: any) {
	const json = JSON.stringify(data)
		.replaceAll("\\", "\\\\")
		.replaceAll("'", "\\'")
	return `window.${name} = JSON.parse('${json}')`
}

export type CronUnit = string
export type CronRule =
	| `${CronUnit} ${CronUnit} ${CronUnit} ${CronUnit} ${CronUnit}`
	| "yearly"
	| "monthly"
	| "weekly"
	| "daily"
	| "hourly"
	| "minutely"

const isReal = (n: any) => n !== undefined && n !== null && !isNaN(n)

// TODO: support intervals
export function cron(rule: CronRule, action: () => void) {
	if (rule === "yearly") return cron("0 0 1 1 *", action)
	if (rule === "monthly") return cron("0 0 1 * *", action)
	if (rule === "weekly") return cron("0 0 * * 0", action)
	if (rule === "daily") return cron("0 0 * * *", action)
	if (rule === "hourly") return cron("0 * * * *", action)
	if (rule === "minutely") return cron("* * * * *", action)
	let paused = false
	const [min, hour, date, month, day] = rule
		.split(" ")
		.map((def) => def === "*" ? "*" : new Set(def.split(",").map(Number).filter(isReal)))
	function run() {
		if (paused) return
		const now = new Date()
		if (month !== "*" && !month.has(now.getUTCMonth() + 1)) return
		if (date !== "*" && !date.has(now.getUTCDate())) return
		if (day !== "*" && !day.has(now.getUTCDay())) return
		if (hour !== "*" && !hour.has(now.getUTCHours())) return
		if (min !== "*" && !min.has(now.getUTCMinutes())) return
		action()
	}
	const timeout = setInterval(run, 1000 * 60)
	run()
	return {
		action: action,
		cancel: () => clearInterval(timeout),
		get paused() {
			return paused
		},
		set paused(p) {
			paused = p
		},
	}
}

const alphaNumChars = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"

// TODO: filter bad words?
export function randAlphaNum(len: number = 11) {
	let str = ""
	for (let i = 0; i < len; i++) {
		str += alphaNumChars.charAt(Math.floor(Math.random() * alphaNumChars.length))
	}
	return str
}

export const ansi = {
	reset:     "\x1b[0m",
	black:     "\x1b[30m",
	red:       "\x1b[31m",
	green:     "\x1b[32m",
	yellow:    "\x1b[33m",
	blue:      "\x1b[34m",
	magenta:   "\x1b[35m",
	cyan:      "\x1b[36m",
	white:     "\x1b[37m",
	blackbg:   "\x1b[40m",
	redbg:     "\x1b[41m",
	greenbg:   "\x1b[42m",
	yellowbg:  "\x1b[43m",
	bluebg:    "\x1b[44m",
	magentabg: "\x1b[45m",
	cyanbg:    "\x1b[46m",
	whitebg:   "\x1b[47m",
	bold:      "\x1b[1m",
	dim:       "\x1b[2m",
	italic:    "\x1b[3m",
	underline: "\x1b[4m",
	rgb: (r: number, g: number, b: number) => `\x1b[38;2;${r};${g};${b}m`,
	rgbbg: (r: number, g: number, b: number) => `\x1b[48;2;${r};${g};${b}m`,
}
