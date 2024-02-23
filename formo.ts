import * as fs from "fs/promises"

import {
	createServer,
	createDatabase,
	route,
	h,
	css,
	csslib,
	formToJSON,
} from "./www"

import type {
	ColumnType,
	TableSchema,
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

const cfg: Config = await Bun.file(process.argv[2]).json()

const server = createServer({ port: Bun.env["PORT"] ?? 80 })
console.log(`starting server on ${server.url.toString()}`)

const db = createDatabase(cfg.dbfile ?? "formo.sqlite")

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
	}
}

const formTable = db.table("formdata", columns, {
	timeCreated: true,
	timeUpdated: true,
})

// TODO: have a uniform default style
const styles = {
	"*": {
		"box-sizing": "border-box",
		"margin": "0",
		"padding": "0",
		"font-size": "24px",
		"font-family": "Monospace",
	},
	"html": {
		"width": "100%",
		"height": "100%",
	},
	"body": {
		"width": "100%",
		"height": "100%",
		"padding": "32px",
	},
	"main": {
		"max-width": "640px",
		"width": "100%",
		"margin": "0 auto",
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
}

server.use(route("GET", "/", ({ req, res }) => {
	return res.sendHTML("<!DOCTYPE html>" + h("html", {}, [
		h("head", {}, [
			cfg.title ? h("title", {}, cfg.title) : null,
			cfg.description ? h("meta", { name: "description", content: cfg.description, }) : null,
			h("meta", { name: "viewport", content: "width=device-width, initial-scale=1" }),
			cfg.icon ? h("link", { rel: "icon", href: cfg.icon }) : null,
			h("style", {}, csslib()),
			h("style", {}, css(styles)),
		]),
		h("body", {}, [
			h("main", {}, [
				h("form", { method: "post", action: "/submit", class: "vstack g16" }, [
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
							}
						})()
						return h("label", { class: "vstack g8" }, [
							f.prompt,
							el,
						])
					}),
					h("input", { type: "submit" }),
				]),
			]),
		]),
	]))
}))

const boolFields = cfg.fields
	.filter((f) => f.type === "checkbox")
	.map((f) => fixName(f.name ?? f.prompt))

server.use(route("POST", "/submit", async ({ req, res }) => {
	const form = await req.formData()
	const json = formToJSON(form)
	for (const f of boolFields) {
		json[f] = Boolean(json[f])
	}
	formTable.insert(json)
	return res.sendText("Success!")
}))
