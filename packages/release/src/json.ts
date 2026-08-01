const MAX_JSON_DEPTH = 128;

export class DuplicateJsonKeyError extends SyntaxError {}
export class UnsafeJsonKeyError extends SyntaxError {}

const unsafeObjectKeys = new Set(["__proto__", "constructor", "prototype"]);

class StrictJsonScanner {
  private index = 0;

  constructor(private readonly source: string) {}

  scan(): void {
    this.skipWhitespace();
    this.parseValue(0);
    this.skipWhitespace();
    if (this.index !== this.source.length) this.fail();
  }

  private parseValue(depth: number): void {
    if (depth > MAX_JSON_DEPTH) this.fail();
    const character = this.source[this.index];
    if (character === "{") {
      this.parseObject(depth + 1);
      return;
    }
    if (character === "[") {
      this.parseArray(depth + 1);
      return;
    }
    if (character === '"') {
      this.parseString();
      return;
    }
    if (character === "t") {
      this.parseLiteral("true");
      return;
    }
    if (character === "f") {
      this.parseLiteral("false");
      return;
    }
    if (character === "n") {
      this.parseLiteral("null");
      return;
    }
    if (character === "-" || (character !== undefined && character >= "0" && character <= "9")) {
      this.parseNumber();
      return;
    }
    this.fail();
  }

  private parseObject(depth: number): void {
    this.index += 1;
    this.skipWhitespace();
    if (this.consume("}")) return;

    const keys = new Set<string>();
    while (true) {
      if (this.source[this.index] !== '"') this.fail();
      const key = this.parseString();
      if (keys.has(key)) throw new DuplicateJsonKeyError();
      if (unsafeObjectKeys.has(key)) throw new UnsafeJsonKeyError();
      keys.add(key);

      this.skipWhitespace();
      if (!this.consume(":")) this.fail();
      this.skipWhitespace();
      this.parseValue(depth);
      this.skipWhitespace();
      if (this.consume("}")) return;
      if (!this.consume(",")) this.fail();
      this.skipWhitespace();
    }
  }

  private parseArray(depth: number): void {
    this.index += 1;
    this.skipWhitespace();
    if (this.consume("]")) return;

    while (true) {
      this.parseValue(depth);
      this.skipWhitespace();
      if (this.consume("]")) return;
      if (!this.consume(",")) this.fail();
      this.skipWhitespace();
    }
  }

  private parseString(): string {
    this.index += 1;
    let value = "";
    while (this.index < this.source.length) {
      const character = this.source[this.index];
      if (character === '"') {
        this.index += 1;
        return value;
      }
      if (character === "\\") {
        this.index += 1;
        value += this.parseEscape();
        continue;
      }
      if (character === undefined || character.charCodeAt(0) <= 0x1f) this.fail();
      value += character;
      this.index += 1;
    }
    this.fail();
  }

  private parseEscape(): string {
    const character = this.source[this.index];
    this.index += 1;
    if (character === '"' || character === "\\" || character === "/") {
      return character;
    }
    if (character === "b") return "\b";
    if (character === "f") return "\f";
    if (character === "n") return "\n";
    if (character === "r") return "\r";
    if (character === "t") return "\t";
    if (character !== "u") this.fail();

    const hex = this.source.slice(this.index, this.index + 4);
    if (!/^[a-fA-F0-9]{4}$/.test(hex)) this.fail();
    this.index += 4;
    return String.fromCharCode(Number.parseInt(hex, 16));
  }

  private parseNumber(): void {
    if (this.consume("-") && this.index === this.source.length) this.fail();

    if (this.consume("0")) {
      if (this.isDigit(this.source[this.index])) this.fail();
    } else {
      const first = this.source[this.index];
      if (first === undefined || first < "1" || first > "9") this.fail();
      this.index += 1;
      while (this.isDigit(this.source[this.index])) this.index += 1;
    }

    if (this.consume(".")) {
      if (!this.isDigit(this.source[this.index])) this.fail();
      while (this.isDigit(this.source[this.index])) this.index += 1;
    }

    const exponent = this.source[this.index];
    if (exponent === "e" || exponent === "E") {
      this.index += 1;
      const sign = this.source[this.index];
      if (sign === "+" || sign === "-") this.index += 1;
      if (!this.isDigit(this.source[this.index])) this.fail();
      while (this.isDigit(this.source[this.index])) this.index += 1;
    }
  }

  private parseLiteral(literal: string): void {
    if (this.source.slice(this.index, this.index + literal.length) !== literal) {
      this.fail();
    }
    this.index += literal.length;
  }

  private skipWhitespace(): void {
    while (
      this.source[this.index] === " " ||
      this.source[this.index] === "\t" ||
      this.source[this.index] === "\n" ||
      this.source[this.index] === "\r"
    ) {
      this.index += 1;
    }
  }

  private consume(expected: string): boolean {
    if (this.source[this.index] !== expected) return false;
    this.index += 1;
    return true;
  }

  private isDigit(character: string | undefined): boolean {
    return character !== undefined && character >= "0" && character <= "9";
  }

  private fail(): never {
    throw new SyntaxError("Invalid JSON");
  }
}

/** Validates JSON grammar and rejects duplicate decoded keys in each object. */
export const assertJsonObjectKeysUnique = (source: string): void => {
  new StrictJsonScanner(source).scan();
};
