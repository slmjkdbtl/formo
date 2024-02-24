.PHONY: dev
dev:
	DEV=1 bun run --watch formo.ts -- example.json

.PHONY: build
build:
	bun build formo.ts --compile --outfile build/formo

.PHONY: clean
clean:
	rm -rf .*.bun-build
	rm -rf *.tsbuildinfo
