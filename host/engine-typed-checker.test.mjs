import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { ESLint } from "eslint";

import { fixture, run, oracle, comparable } from "./test-support/fixture.mjs";

test("readonly checks recognize prefix and postfix mutations", async t => {
  const f = fixture(t, {
    typed: true,
    rules: { "@typescript-eslint/prefer-readonly": "error" },
    source: `export class Counters {
 private prefixIncrement = 0;
 private postfixIncrement = 0;
 private prefixDecrement = 0;
 private postfixDecrement = 0;
 private unchanged = 0;
 tick() {
  ++this.prefixIncrement;
  this.postfixIncrement++;
  --this.prefixDecrement;
  this.postfixDecrement--;
  return +this.unchanged;
 }
}
`,
  });
  const expected = await oracle(f);
  assert.equal(expected.messages.length, 1);
  assert.match(expected.messages[0].message, /unchanged/);
  const actual = run(f);
  assert.equal(actual.status, 1, actual.stderr);
  assert.deepEqual(JSON.parse(actual.stdout)[0], expected);
});

test("nodes returned inside callback objects preserve identity and synthetic children", async t => {
  const f = fixture(t, {
    typed: true,
    rules: {},
    source: `interface Parent<T> { parent: T }
declare namespace Types { interface Base<T> { base: T } }
export interface Box<T extends string = string> extends Parent<T>, Types.Base<string> {
 value?: T;
 nested: Map<string, ReadonlyArray<T | undefined>>;
 convert<U>(input: U): [T, U];
}
`,
    extraConfig: `{plugins: {probe: {rules: {children: {meta: {schema: []}, create(context) {
      const services = context.sourceCode.parserServices;
      return {TSInterfaceDeclaration(node) {
        const children = [];
        function visit(child) {
          children.push([child.kind, child.getStart(), child.end, child.getText()]);
          child.getChildren().some(descendant => { visit(descendant); return false; });
        }
        const declaration = services.esTreeNodeToTSNodeMap.get(node);
        const applications = declaration.heritageClauses?.flatMap(clause =>
          clause.types.map(type => ({node: type}))) ?? [];
        applications.forEach(application => {
          if (application.node !== declaration.heritageClauses.flatMap(clause => [...clause.types]).find(type => type.pos === application.node.pos))
            throw new Error('Callback changed node identity');
          visit(application.node);
        });
        context.report({node: node.id, message: JSON.stringify(children)});
      }};
    }}}}}, rules: {'probe/children': 'warn'}}`,
  });
  const expected = await oracle(f);
  assert.equal(expected.messages.length, 3);
  const actual = run(f);
  assert.equal(actual.status, 0, actual.stderr);
  assert.deepEqual(JSON.parse(actual.stdout)[0], expected);
});

test("tuple minimum lengths distinguish empty, optional, required, rest, and variadic elements", async t => {
  const f = fixture(t, {
    typed: true,
    rules: {},
    source:
      "export type Empty = [];\nexport type Optional = [string?];\nexport type Required = [string, number?];\nexport type Rest = [string, ...number[]];\nexport type Variadic<T extends unknown[]> = [...T, string];\n",
    extraConfig: `{plugins: {probe: {rules: {minimum: {meta: {schema: []}, create(context) {const s = context.sourceCode.parserServices; const c = s.program.getTypeChecker(); return {TSTypeAliasDeclaration(node) {const type = c.getTypeAtLocation(s.esTreeNodeToTSNodeMap.get(node)); context.report({node: node.id, message: String(type.target.minLength)});}};}}}}}, rules: {'probe/minimum': 'warn'}}`,
  });
  const actual = run(f);
  assert.equal(actual.status, 0, actual.stderr);
  const expected = await oracle(f);
  assert.deepEqual(
    expected.messages.map(message => message.message),
    ["0", "0", "1", "1", "2"],
  );
  assert.deepEqual(JSON.parse(actual.stdout)[0], expected);
});

test("boolean literal intrinsics preserve allowed constant loops without allowing false loops", async t => {
  const f = fixture(t, {
    typed: true,
    rules: {
      "@typescript-eslint/no-unnecessary-condition": [
        "error",
        { allowConstantLoopConditions: true },
      ],
    },
    source:
      "export function loop() {\n while (true) { break; }\n while (false) { break; }\n const allowed = true as const;\n while (allowed) { break; }\n if (true) console.log('constant');\n}\n",
  });
  const actual = run(f);
  assert.equal(actual.status, 1, actual.stderr);
  const expected = await oracle(f);
  assert.deepEqual(
    expected.messages.map(message => message.line),
    [3, 6],
  );
  assert.deepEqual(JSON.parse(actual.stdout)[0], expected);
});

test("unchanged typed rules use the Rust checker for imported, generic, and union types", async t => {
  const f = fixture(t, {
    typed: true,
    rules: {
      "@typescript-eslint/no-unsafe-unary-minus": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-unsafe-return": "error",
    },
    source: `import { text, promised } from './types';
-text;
declare const mixed: string | number;
-mixed;
function negate<T extends string>(value: T) { return -value; }
async function check() {
 await text;
 await promised;
 promised.then(value => value.length);
}
async function* chunks() { yield 'chunk'; }
async function readChunks() {
 for await (const chunk of chunks()) { console.log(chunk); }
}
export const sequence = async () => (await promised, text);
`,
  });
  writeFileSync(
    join(f.dir, "types.ts"),
    "export const text: string = 'hello';\nexport const promised: Promise<string> = Promise.resolve(text);\n",
  );
  const actual = run(f);
  assert.equal(actual.status, 1, actual.stderr);
  const expected = await oracle(f);
  assert.deepEqual(
    JSON.parse(actual.stdout)[0].messages.map(comparable),
    expected.messages.map(comparable),
  );
});

test("the configured typed rule set matches ESLint on mixed TypeScript syntax", async t => {
  const rules = Object.fromEntries(
    [
      "@typescript-eslint/await-thenable",
      "@typescript-eslint/no-array-delete",
      "@typescript-eslint/no-deprecated",
      "@typescript-eslint/no-duplicate-type-constituents",
      "@typescript-eslint/no-floating-promises",
      "@typescript-eslint/no-for-in-array",
      "@typescript-eslint/no-implied-eval",
      "@typescript-eslint/no-misused-promises",
      "@typescript-eslint/no-unnecessary-condition",
      "@typescript-eslint/no-unnecessary-qualifier",
      "@typescript-eslint/no-unnecessary-template-expression",
      "@typescript-eslint/no-unnecessary-type-arguments",
      "@typescript-eslint/no-unnecessary-type-assertion",
      "@typescript-eslint/no-unsafe-assignment",
      "@typescript-eslint/no-unsafe-call",
      "@typescript-eslint/no-unsafe-enum-comparison",
      "@typescript-eslint/no-unsafe-member-access",
      "@typescript-eslint/no-unsafe-return",
      "@typescript-eslint/no-unsafe-unary-minus",
      "@typescript-eslint/non-nullable-type-assertion-style",
      "@typescript-eslint/only-throw-error",
      "@typescript-eslint/prefer-find",
      "@typescript-eslint/prefer-includes",
      "@typescript-eslint/prefer-nullish-coalescing",
      "@typescript-eslint/prefer-optional-chain",
      "@typescript-eslint/prefer-promise-reject-errors",
      "@typescript-eslint/prefer-readonly",
      "@typescript-eslint/prefer-regexp-exec",
      "@typescript-eslint/prefer-return-this-type",
      "@typescript-eslint/prefer-string-starts-ends-with",
      "@typescript-eslint/promise-function-async",
      "@typescript-eslint/require-await",
      "@typescript-eslint/restrict-plus-operands",
      "@typescript-eslint/restrict-template-expressions",
      "@typescript-eslint/unbound-method",
      "@typescript-eslint/use-unknown-in-catch-callback-variable",
      "@typescript-eslint/no-mixed-enums",
      "@typescript-eslint/no-redundant-type-constituents",
      "@typescript-eslint/no-unnecessary-boolean-literal-compare",
    ].map(id => [id, "error"]),
  );
  const f = fixture(t, {
    typed: true,
    rules,
    source: `export type Mode = 'a' | 'b';
declare const unsafe: any;
declare const optional: { name: string } | null;
declare const items: string[];
export async function convert<T extends string>(input: T) {
 const assigned: string = unsafe;
 unsafe.call();
 const combined = assigned + true;
 const label = optional && optional.name;
 const fallback = optional || { name: 'default' };
 const duplicate: string | string = input;
 const forced = assigned as string;
 await assigned;
 Promise.resolve(assigned);
 delete items[0];
 for (const key in items) { console.log(key); }
 if (input === '') { throw 'bad'; }
 return [combined, label, fallback, duplicate, forced, String(input)];
}
export class Service {
 private label = 'name';
 run() { return this.label; }
}
export const callback = new Service().run;
export function select(mode: Mode) { switch (mode) { case 'a': return 1; } }
/** @deprecated Use the replacement. */
declare function legacy(): void;
legacy();
enum Mixed { A = 1, B = 'two' }
enum Other { A = 1 }
declare const mixedEnum: Mixed;
if (mixedEnum === Other.A) console.log(mixedEnum);
export type Redundant = string | 'literal';
declare const maybe: number | null;
declare const numbers: number[];
declare const flag: boolean;
export const definitely = maybe as number;
export const checked = flag === true;
export const contains = numbers.indexOf(1) !== -1;
export const first = numbers.filter(value => value > 1)[0];
export const matched = 'hello'.match(/hi/);
export const starts = 'hello'.indexOf('he') === 0;
export const unnecessary = Boolean(flag);
export const asserted = unsafe as string;
export const spread = { ...'hello' };
export async function requiresAwait() { return 1; }
export function noReturn(value: string): void { console.log(value); }
export const confused = () => noReturn('text');
void noReturn('text');
Promise.reject('error');
Promise.resolve(1).catch(error => console.log(error));
setTimeout('code', 1);
export const reduced = numbers.reduce((result, value) => ({ ...result, [value]: value }), {} as Record<string, number>);
export function defaults(value: string = 'same') { return value; }
defaults('same');
export class Chain { run(): Chain { return this; } }
export class Accessors { get value(): string { return ''; } set value(input: number) { console.log(input); } }
export function destructured({ value }: { value: string }, [first]: number[]) { return value + first; }
export const plainDestructure = ({ value }) => value;
export const shorthand = { flag };
export const loader = async () => import('./sample');
export const objectMethods = { run() { return 1; }, get value() { return 2; } };
export const location = import.meta.url;
declare module 'missing-types';
`,
  });
  const actual = run(f);
  assert.equal(actual.status, 1, actual.stderr);
  const expected = await oracle(f);
  assert.deepEqual(
    JSON.parse(actual.stdout)[0].messages.map(comparable),
    expected.messages.map(comparable),
  );
});

test("typed TSX callbacks preserve contextual types and deprecated props", async t => {
  const f = fixture(t, {
    typed: true,
    tsx: true,
    rules: {
      "@typescript-eslint/no-deprecated": "warn",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/no-unsafe-assignment": "warn",
    },
    source: `export {};
declare global { namespace JSX { interface Element {} } }
interface Props {
 /** @deprecated Use label. */
 title?: string;
 onClick?: () => void;
 label?: string;
}
declare function Component(props: Props): JSX.Element;
declare const unsafe: any;
const element = <Component title="old" label={unsafe} onClick={async () => { await Promise.resolve(); }} />;
`,
  });
  const actual = run(f);
  assert.equal(actual.status, 1, actual.stderr);
  const expected = await oracle(f);
  assert.deepEqual(
    JSON.parse(actual.stdout)[0].messages.map(comparable),
    expected.messages.map(comparable),
  );
});

test("typed rules observe legacy enum members and optional generic targets", async t => {
  const f = fixture(t, {
    typed: true,
    rules: {},
    extraConfig: `{plugins: {fixture: {rules: {
      'enum-member-types': {
        meta: {schema: []},
        create(context) {
          const services = context.sourceCode.parserServices;
          const checker = services.program.getTypeChecker();
          return {
            TSEnumDeclaration(node) {
              if (node.const) return;
              for (const member of node.body.members) {
                const tsNode = services.esTreeNodeToTSNodeMap.get(member.id);
                const memberType = checker.getTypeAtLocation(tsNode);
                context.report({node: member.id, message: (member.id.name ?? 'literal') + ':' + checker.typeToString(memberType)});
              }
            }
          };
        }
      },
      'optional-generic-targets': {
        meta: {schema: []},
        create(context) {
          return {
            TSTypeParameter(node) {
              if (node.default != null)
                context.report({node: node.name, message: 'optional generic parameter ' + node.name.name});
            }
          };
        }
      }
    }}}, rules: {
      'fixture/enum-member-types': 'error',
      'fixture/optional-generic-targets': 'error',
      '@typescript-eslint/no-useless-default-assignment': 'error',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/no-unnecessary-type-arguments': 'error',
      '@typescript-eslint/no-unnecessary-type-parameters': 'error',
      '@typescript-eslint/prefer-readonly': 'error',
      '@typescript-eslint/no-deprecated': 'warn',
      '@typescript-eslint/no-unsafe-assignment': 'warn'
    }}`,
    source: `export const text = "value";
export enum Values { A = "a", B = "b" }
export enum Numeric { A, B }
export const callback = async (input: string): Promise<string> => { return input; };
declare function decorate<T>(value: T): T;
@decorate
export class Decorated { private value = 1; read() { return this.value; } }
interface Base<T = string> { value: T }
interface Child extends Base<string> {}
interface Callable { <T>(value: T): void; new<T>(value: T): Base<T> }
declare function generic<T = string>(value: T): T;
const instantiated = generic<string>;
export * from './dependency';
namespace Qualified { export interface Base<T> { value: T } }
export class Implementation implements Qualified.Base<string> {
 value: string;
 constructor(args: { value: string }) { this.value = args.value; }
}
abstract class Abstract { abstract call<T>(value: T): void; }
declare const unsafe: any;
let result: unknown;
({ value: result } = unsafe);
[result] = unsafe;
declare const optional: undefined | { run<T = string>(): T };
optional?.run<string>();
declare const values: unknown[];
export const strings = values.filter((value): value is string => typeof value === 'string');
export const numbers = values.filter((value): value is number => typeof value === 'number');
export const booleans = values.filter((value): value is boolean => typeof value === 'boolean');
export const bigints = values.filter((value): value is bigint => typeof value === 'bigint');
export const symbols = values.filter((value): value is symbol => typeof value === 'symbol');
export const missing = values.filter((value): value is undefined => typeof value === 'undefined');
export const tuple = values.filter((value): value is [1, 2, 3] => typeof value === 'number');
export class DefaultParameter { constructor(private readonly value: string | undefined = undefined) {} }
declare function variadic(...args: unknown): void;
variadic(1, 2 as number);
`,
  });
  writeFileSync(
    join(f.dir, "dependency.ts"),
    "export const value = 'plain';\n",
  );
  const actual = run(f);
  assert.equal(actual.status, 1, actual.stderr);
  assert.deepEqual(JSON.parse(actual.stdout)[0], await oracle(f));
});

test("const-enum-only modules preserve TypeScript 6 symbol flags and metadata", async t => {
  const f = fixture(t, {
    typed: true,
    source:
      "namespace Palette { export const enum Color { Red } }\nconst selected: Palette.Color = Palette.Color.Red;\n",
    rules: { "fixture/module-marker": "error" },
    extraConfig: `{
      plugins: { fixture: { rules: {
        'module-marker': {
          meta: { schema: [] },
          create(context) {
            const services = context.sourceCode.parserServices;
            const checker = services.program.getTypeChecker();
            return { TSTypeReference(node) {
              const ref = services.esTreeNodeToTSNodeMap.get(node);
              const symbol = checker.getSymbolAtLocation(ref.typeName.left);
              if (symbol === undefined) throw new Error('Missing namespace symbol');
              context.report({ node, message: String(symbol.flags) + ':' + String(symbol.getFlags()) + ':' + String(symbol.constEnumOnlyModule) });
            } };
          }
        }
      } } }
    }`,
  });
  const actual = run(f);
  assert.equal(actual.status, 1, actual.stderr);
  const result = JSON.parse(actual.stdout)[0];
  const expected = await oracle(f);
  assert.equal(expected.messages.length, 1);
  assert.match(expected.messages[0].message, /:true$/u);
  assert.deepEqual(result.messages, expected.messages);
});
