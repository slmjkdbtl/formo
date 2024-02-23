import * as crypto from "crypto"

import {
	createServer,
	createDatabase,
	route,
	h,
	css,
	csslib,
	formToJSON,
	getFormBlob,
} from "./www"

import type {
	ColumnType,
	TableSchema,
	HTMLChild,
} from "./www"

type Config = {
	title?: string,
	description?: string,
	fields: Field[],
	icon?: string,
	css?: string,
	dbfile?: string,
}

type Field = {
	prompt: string,
	name?: string,
	required?: boolean,
} & TypedField

type TypedField =
	| {
		type: "range",
		value?: number,
		min: number,
		max: number,
		step?: number,
	}
	| {
		type: "number",
		value?: number,
		min?: number,
		max?: number,
		placeholder?: number,
	}
	| {
		type: "select",
		value?: string,
		options: string[],
	}
	| {
		type: "checkbox",
		checked?: boolean,
	}
	| {
		type: "color" | "date" | "time",
		value?: string,
	}
	| {
		type: "textarea",
		value?: string,
		placeholder?: string,
	}
	| {
		type: "text" | "email" | "url" | "password" | "tel",
		value?: string,
		placeholder?: string,
		minlength?: number,
		maxlength?: number,
		pattern?: string,
	}
	| {
		type: "file",
		accept?: string,
	}

const cfg: Config = await Bun.file(process.argv[2]).json()

const server = createServer({ port: Bun.env["PORT"] ?? 80 })
console.log(`starting server on ${server.url.toString()}`)

const db = createDatabase(cfg.dbfile ?? "data.sqlite")

const columns: TableSchema = {
	"id": { type: "INTEGER", primaryKey: true, autoIncrement: true },
}

function fixName(str: string) {
	return str
		.toLowerCase()
		.replaceAll(" ", "_")
		.replace(/[^0-9a-z_]/g, "")
}

function fieldTypeToDBType(ty: Field["type"]): ColumnType {
	switch (ty) {
		case "range":
		case "number":
			return "REAL"
		case "checkbox":
			return "BOOLEAN"
		default:
			return "TEXT"
	}
}

for (const field of cfg.fields) {
	const name = fixName(field.name ?? field.prompt)
	columns[name] = {
		type: fieldTypeToDBType(field.type),
		// TODO
		allowNull: true,
	}
	if (field.type === "file") {
		columns[name].reference = { table: "blob", column: "id" }
	}
}

const formTable = db.table("formdata", columns, {
	timeCreated: true,
	timeUpdated: true,
})

type DBBlob = {
	id: string,
	data: Uint8Array,
	type: string,
}

const blobTable = db.table<DBBlob>("blob", {
	"id":   { type: "TEXT", primaryKey: true },
	"data": { type: "BLOB" },
	"type": { type: "TEXT" },
}, {
	timeCreated: true,
	timeUpdated: true,
})

// TODO: have a uniform default style
const theme = {
	"*": {
		"box-sizing": "border-box",
		"margin": "0",
		"padding": "0",
		"font-family": "Monospace",
	},
	"html": {
		"width": "100%",
		"height": "100%",
	},
	"body": {
		"width": "100%",
		"height": "100%",
	},
	"input": {
		"padding": "8px",
	},
	"input[type=checkbox]": {
		"width": "24px",
		"height": "24px",
	},
	"input[type=color]": {
		"width": "120px",
		"height": "48px",
	},
	"textarea": {
		"padding": "8px",
	},
	"select": {
		"padding": "8px",
	},
	"fieldset": {
		"padding": "8px",
		"border": "solid 1px #767676",
		"border-radius": "2px",
	},
	"table": {
		"border-collapse": "collapse",
	},
	"th,td": {
		"border": "1px solid black",
		"padding": "4px",
	},
}

function page(head: HTMLChild[], body: HTMLChild[]) {
	return "<!DOCTYPE html>" + h("html", {}, [
		h("head", {}, [
			h("style", {}, css(theme)),
			h("style", {}, csslib()),
			...head,
		]),
		h("body", {}, [
			...body,
		]),
	])
}

server.use(route("GET", "/", ({ req, res }) => {
	return res.sendHTML(page([
		cfg.title ? h("title", {}, cfg.title) : null,
		cfg.description ? h("meta", { name: "description", content: cfg.description, }) : null,
		h("meta", { name: "viewport", content: "width=device-width, initial-scale=1" }),
		cfg.icon ? h("link", { rel: "icon", href: cfg.icon }) : null,
		h("style", {}, css({
			"*": {
				"font-size": "24px",
			},
			"body": {
				"padding": "32px",
			},
			"main": {
				"max-width": "640px",
				"width": "100%",
				"margin": "0 auto",
			},
		})),
	], [
		h("main", {}, [
			h("form", {
				method: "post",
				action: "/submit",
				enctype: "multipart/form-data",
				class: "vstack g16",
			}, [
				...cfg.fields.map((f) => {
					const name = fixName(f.name ?? f.prompt)
					const el = (() => {
						switch (f.type) {
							case "textarea":
								return h("textarea", {
									name: name,
									required: f.required,
									placeholder: f.placeholder,
								}, f.value ?? "")
							case "select":
								return h("select", { name: name }, f.options.map((o) => {
									return h("option", {}, o)
								}))
							case "text":
							case "email":
							case "text":
							case "url":
							case "password":
								return h("input", {
									name: name,
									type: "text",
									value: f.value,
									placeholder: f.placeholder,
									minlength: f.minlength,
									maxlength: f.maxlength,
									pattern: f.pattern,
								})
							case "range":
								return h("input", {
									name: name,
									type: "range",
									value: f.value,
									min: f.min,
									max: f.max,
									step: f.step,
								})
							case "number":
								return h("input", {
									name: name,
									type: "number",
									value: f.value,
									min: f.min,
									max: f.max,
								})
							case "checkbox":
								return h("input", {
									name: name,
									type: "checkbox",
									checked: f.checked,
								})
							case "date":
							case "time":
							case "color":
								return h("input", {
									name: name,
									type: f.type,
									value: f.value,
								})
							case "file":
								return h("input", {
									name: name,
									type: f.type,
									accept: f.accept,
								})
						}
					})()
					return h("label", { class: "vstack g8" }, [
						h("span", { class: "hstack g8 align-center" }, [
							f.required
								? h("span", {
									style: {
										color: "red",
									},
								}, "*")
								: null,
							f.prompt,
						]),
						el,
					])
				}),
				h("input", { type: "submit" }),
			]),
		]),
	]))
}))

const boolFields = cfg.fields
	.filter((f) => f.type === "checkbox")
	.map((f) => fixName(f.name ?? f.prompt))

const blobFields = cfg.fields
	.filter((f) => f.type === "file")
	.map((f) => fixName(f.name ?? f.prompt))

server.use(route("POST", "/submit", async ({ req, res }) => {
	const form = await req.formData()
	const json = formToJSON(form)
	for (const f of boolFields) {
		json[f] = Boolean(json[f])
	}
	for (const f of blobFields) {
		const id = crypto.randomUUID()
		const blob = getFormBlob(form, f)
		if (!blob) {
			delete json[f]
			continue
		}
		const data = new Uint8Array(await blob.arrayBuffer())
		blobTable.insert({
			"id": id,
			"data": data,
			"type": blob.type,
		})
		json[f] = id
	}
	formTable.insert(json)
	return res.sendText("Success!")
}))

// TODO: auth
server.use(route("GET", "/data", async ({ req, res }) => {
	const rows = formTable.select()
	return res.sendHTML(page([
		cfg.title ? h("title", {}, cfg.title) : null,
		cfg.description ? h("meta", { name: "description", content: cfg.description, }) : null,
		h("meta", { name: "viewport", content: "width=device-width, initial-scale=1" }),
		cfg.icon ? h("link", { rel: "icon", href: cfg.icon }) : null,
		h("style", {}, css({
			"*": {
				"font-size": "12px",
			},
			"body": {
				"padding": "12px",
			},
			"table": {
				"width": "100%",
			},
		})),
	], [
		h("table", {}, [
			h("tr", {}, [
				h("th", {}, "#"),
				...cfg.fields.map((f) => {
					return h("th", {}, fixName(f.name ?? f.prompt))
				}),
			]),
			...rows.map((r) => {
				return h("tr", {}, [
					h("td", {}, r.id),
					...cfg.fields.map((f) => {
						const k = fixName(f.name ?? f.prompt)
						if (f.type === "file") {
							return h("td", {}, r[k] ? [
								h("a", { href: `/blob/${r[k]}` }, "view"),
							] : "")
						} else {
							return h("td", {}, r[k])
						}
					}),
				])
			}),
		]),
	]))
}))

server.use(route("GET", "/blob/:id", async ({ req, res, next }) => {
	const id = req.params["id"]
	const img = blobTable.find({ "id": id })
	if (!img) return next()
	return res.send(new Blob([img.data], { type: img.type }))
}))
