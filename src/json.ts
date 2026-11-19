// Lossless JSON for settings files. Numbers keep their exact source text, so an integer above 2^53
// or a value like 1.0 is written back as it was. Call JSON.parse first to validate the text.

/** A number token, kept as its source text. */
export class RawNumber {
	constructor(readonly raw: string) {}
}

export type LJson = null | boolean | string | RawNumber | LJson[] | { [k: string]: LJson };

function setOwn(o: Record<string, LJson>, k: string, v: LJson): void {
	// defineProperty keeps a key such as "__proto__" as a plain own key, the same as JSON.parse.
	Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
}

/** Parses JSON text that JSON.parse already accepted. */
export function parseLossless(text: string): LJson {
	let i = 0;
	const ws = (): void => { while (i < text.length && ' \t\n\r'.includes(text[i]!)) i++; };
	const str = (): string => {
		const start = i;
		i++;
		while (text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
		i++;
		return JSON.parse(text.slice(start, i)) as string;
	};
	const value = (): LJson => {
		ws();
		const c = text[i];
		if (c === '{') {
			i++;
			const o: Record<string, LJson> = {};
			ws();
			if (text[i] === '}') { i++; return o; }
			for (;;) {
				ws();
				const k = str();
				ws();
				i++; // the colon
				setOwn(o, k, value());
				ws();
				if (text[i++] === '}') return o;
			}
		}
		if (c === '[') {
			i++;
			const a: LJson[] = [];
			ws();
			if (text[i] === ']') { i++; return a; }
			for (;;) {
				a.push(value());
				ws();
				if (text[i++] === ']') return a;
			}
		}
		if (c === '"') return str();
		if (text.startsWith('true', i)) { i += 4; return true; }
		if (text.startsWith('false', i)) { i += 5; return false; }
		if (text.startsWith('null', i)) { i += 4; return null; }
		const m = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i, i + 400))!;
		i += m[0].length;
		return new RawNumber(m[0]);
	};
	return value();
}

/** Writes the value in the same layout as JSON.stringify(value, null, indent). */
export function stringifyLossless(v: LJson, indent: string | number): string {
	const unit = typeof indent === 'number' ? ' '.repeat(indent) : indent;
	const go = (x: LJson, pad: string): string => {
		if (x === null) return 'null';
		if (typeof x === 'boolean') return String(x);
		if (typeof x === 'string') return JSON.stringify(x);
		if (x instanceof RawNumber) return x.raw;
		const inner = pad + unit;
		if (Array.isArray(x)) {
			if (!x.length) return '[]';
			return `[\n${x.map(e => inner + go(e, inner)).join(',\n')}\n${pad}]`;
		}
		const keys = Object.keys(x);
		if (!keys.length) return '{}';
		return `{\n${keys.map(k => `${inner}${JSON.stringify(k)}: ${go(x[k]!, inner)}`).join(',\n')}\n${pad}}`;
	};
	return go(v, '');
}
