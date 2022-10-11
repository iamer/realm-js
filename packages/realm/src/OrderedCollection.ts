////////////////////////////////////////////////////////////////////////////
//
// Copyright 2022 Realm Inc.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
////////////////////////////////////////////////////////////////////////////

import * as binding from "./binding";
import { Results } from "./Results";
import { Collection } from "./Collection";
import { unwind } from "./ranges";
import { TypeHelpers } from "./types";
import { getBaseTypeName } from "./schema";
import { IllegalConstructorError, TypeAssertionError } from "./errors";
import { Realm } from "./Realm";
import { Object as RealmObject } from "./Object";
import { getInternal } from "./internal";
import { assert } from "./assert";
import { ClassHelpers } from "./ClassHelpers";

const DEFAULT_COLUMN_KEY = 0n as unknown as binding.ColKey;

type PropertyType = string;
export type SortDescriptor = string | [string, boolean];

export type CollectionChangeSet = {
  insertions: number[];
  deletions: number[];
  newModifications: number[];
  oldModifications: number[];
};
export type CollectionChangeCallback<T> = (collection: OrderedCollection<T>, changes: CollectionChangeSet) => void;

/** @internal */
export type OrderedCollectionHelpers = TypeHelpers & {
  get(results: binding.Results, index: number): unknown;
};

const DEFAULT_PROPERTY_DESCRIPTOR: PropertyDescriptor = { configurable: true, enumerable: true, writable: true };
const PROXY_HANDLER: ProxyHandler<OrderedCollection> = {
  // TODO: Consider executing the `parseInt` first to optimize for index access over accessing a member on the list
  get(target, prop) {
    if (Reflect.has(target, prop)) {
      return Reflect.get(target, prop);
    } else if (typeof prop === "string") {
      const index = Number.parseInt(prop, 10);
      // TODO: Consider catching an error from access out of bounds, instead of checking the length, to optimize for the hot path
      if (!Number.isNaN(index) && index >= 0 && index < target.length) {
        return target.get(index);
      }
    }
  },
  set(target, prop, value, receiver) {
    if (typeof prop === "string") {
      const index = Number.parseInt(prop, 10);
      // TODO: Consider catching an error from access out of bounds, instead of checking the length, to optimize for the hot path
      // TODO: Do we expect an upper bound check on the index when setting?
      if (!Number.isNaN(index) && index >= 0) {
        target.set(index, value);
        return true;
      } else if (index < 0) {
        throw new Error(`Index ${index} cannot be less than zero.`);
      }
    }
    return Reflect.set(target, prop, value, receiver);
  },
  ownKeys(target) {
    return Reflect.ownKeys(target).concat([...target.keys()].map(String));
  },
  getOwnPropertyDescriptor(target, prop) {
    if (Reflect.has(target, prop)) {
      return Reflect.getOwnPropertyDescriptor(target, prop);
    } else if (typeof prop === "string") {
      const index = Number.parseInt(prop, 10);
      if (index < target.length) {
        return DEFAULT_PROPERTY_DESCRIPTOR;
      }
    }
  },
};

export abstract class OrderedCollection<T = unknown>
  extends Collection<number, T, T, CollectionChangeCallback<T>>
  implements ReadonlyArray<T>
{
  /** @internal */
  constructor(
    /** @internal */ protected realm: Realm,
    /** @internal */ private results: binding.Results,
    /** @internal */ protected helpers: OrderedCollectionHelpers,
  ) {
    if (arguments.length === 0) {
      throw new IllegalConstructorError("OrderedCollection");
    }
    super((callback) => {
      return this.results.addNotificationCallback((changes) => {
        try {
          callback(this, {
            deletions: unwind(changes.deletions),
            insertions: unwind(changes.insertions),
            oldModifications: unwind(changes.modifications),
            newModifications: unwind(changes.modificationsNew),
          });
        } catch (err) {
          // Scheduling a throw on the event loop,
          // since throwing synchroniously here would result in an abort in the calling C++
          setImmediate(() => {
            throw err;
          });
        }
      }, []);
    });
    // Get the class helpers for later use, if available
    const { objectType } = results;
    if (typeof objectType === "string" && objectType !== "") {
      this.classHelpers = this.realm.getClassHelpers(objectType);
    } else {
      this.classHelpers = null;
    }
    // Make the internal properties non-enumerable
    Object.defineProperties(this, {
      realm: {
        enumerable: false,
        configurable: false,
        writable: false,
      },
      results: {
        enumerable: false,
        configurable: false,
        writable: false,
      },
      helpers: {
        enumerable: false,
        configurable: false,
        writable: false,
      },
      classHelpers: {
        enumerable: false,
        configurable: false,
        writable: false,
      },
    });
    // Wrap in a proxy to trap ownKeys and get, enabling the spread operator
    return new Proxy(this, PROXY_HANDLER as ProxyHandler<this>);
  }

  private classHelpers: ClassHelpers | null;

  /**
   * Get an element of the ordered collection by index
   * @param index The index
   * @returns The element
   * @internal
   */
  public get(index: number): T {
    return this.helpers.fromBinding(this.helpers.get(this.results, index)) as T;
  }

  /**
   * Set an element of the ordered collection by index
   * @param index The index
   * @param value The value
   * @internal
   */
  public set(index: number, value: unknown) {
    throw new Error(`Assigning into a ${this.constructor.name} is not support`);
  }

  keys(): IterableIterator<number> {
    const size = this.results.size();
    let index = 0;
    return {
      next(): IteratorResult<number, void> {
        if (index < size) {
          return { value: index++, done: false };
        } else {
          return { value: undefined, done: true };
        }
      },
      [Symbol.iterator]() {
        return this;
      },
    };
  }

  values(): IterableIterator<T> {
    const snapshot = this.results.snapshot();
    const fromBinding = this.helpers.fromBinding;
    const get = this.helpers.get;
    function getter(index: number) {
      return fromBinding(get(snapshot, index)) as T;
    }
    const keys = this.keys();
    return {
      next(): IteratorResult<T, void> {
        const { done, value: index } = keys.next();
        if (done) {
          return { value: undefined, done };
        } else {
          return { value: getter(index), done };
        }
      },
      [Symbol.iterator]() {
        return this;
      },
    };
  }

  readonly [n: number]: T;

  get length(): number {
    return this.results.size();
  }

  get type(): PropertyType {
    return getBaseTypeName(this.results.type);
  }
  get optional(): boolean {
    return !!(this.results.type & binding.PropertyType.Nullable);
  }

  toString(): string {
    return [...this].toString();
  }
  toLocaleString(): string {
    return [...this].toLocaleString();
  }
  concat(...items: ConcatArray<T>[]): T[];
  concat(...items: (T | ConcatArray<T>)[]): T[];
  concat(...items: any[]): T[] {
    return [...this].concat(...items);
  }
  join(separator?: string): string {
    return [...this].join(separator);
  }
  slice(start?: number, end?: number): T[] {
    return [...this].slice(start, end);
  }
  indexOf(searchElement: T, fromIndex?: number): number {
    assert(typeof fromIndex === "undefined", "The second fromIndex argument is not yet supported");
    if (searchElement instanceof RealmObject) {
      return this.results.indexOfObj(getInternal(searchElement));
    } else {
      return this.results.indexOf(this.helpers.toBinding(searchElement));
    }
  }
  lastIndexOf(searchElement: T, fromIndex?: number): number {
    return [...this].lastIndexOf(searchElement, fromIndex);
  }
  every<S extends T>(
    predicate: (value: T, index: number, array: readonly T[]) => value is S,
    thisArg?: any,
  ): this is readonly S[];
  every(predicate: (value: T, index: number, array: readonly T[]) => unknown, thisArg?: any): boolean;
  every(predicate: any, thisArg?: any): boolean {
    return [...this].every(predicate, thisArg);
  }
  some(predicate: (value: T, index: number, array: readonly T[]) => unknown, thisArg?: any): boolean {
    return [...this].some(predicate, thisArg);
  }
  forEach(callbackfn: (value: T, index: number, array: readonly T[]) => void, thisArg?: any): void {
    return [...this].forEach(callbackfn, thisArg);
  }
  map<U>(callbackfn: (value: T, index: number, array: readonly T[]) => U, thisArg?: any): U[] {
    return [...this].map(callbackfn, thisArg);
  }
  filter<S extends T>(predicate: (value: T, index: number, array: readonly T[]) => value is S, thisArg?: any): S[];
  filter(predicate: (value: T, index: number, array: readonly T[]) => unknown, thisArg?: any): T[];
  filter<S extends T>(predicate: any, thisArg?: any): T[] | S[] {
    return [...this].filter(predicate, thisArg);
  }
  reduce(callbackfn: (previousValue: T, currentValue: T, currentIndex: number, array: readonly T[]) => T): T;
  reduce(
    callbackfn: (previousValue: T, currentValue: T, currentIndex: number, array: readonly T[]) => T,
    initialValue: T,
  ): T;
  reduce<U>(
    callbackfn: (previousValue: U, currentValue: T, currentIndex: number, array: readonly T[]) => U,
    initialValue: U,
  ): U;
  reduce<U>(callbackfn: any, initialValue?: any): T | U {
    return [...this].reduce(callbackfn, initialValue);
  }
  reduceRight(callbackfn: (previousValue: T, currentValue: T, currentIndex: number, array: readonly T[]) => T): T;
  reduceRight(
    callbackfn: (previousValue: T, currentValue: T, currentIndex: number, array: readonly T[]) => T,
    initialValue: T,
  ): T;
  reduceRight<U>(
    callbackfn: (previousValue: U, currentValue: T, currentIndex: number, array: readonly T[]) => U,
    initialValue: U,
  ): U;
  reduceRight<U>(callbackfn: any, initialValue?: any): T | U {
    return [...this].reduceRight(callbackfn, initialValue);
  }

  find<S extends T>(
    predicate: (this: void, value: T, index: number, obj: T[]) => value is S,
    thisArg?: any,
  ): S | undefined;
  find<T>(predicate: (value: T, index: number, obj: T[]) => unknown, thisArg?: any): T | undefined;
  find(predicate: (value: T, index: number, obj: T[]) => boolean, thisArg?: any): T | undefined {
    return [...this].find(predicate, thisArg);
  }
  findIndex(predicate: (value: T, index: number, obj: readonly T[]) => unknown, thisArg?: any): number {
    return [...this].findIndex(predicate, thisArg);
  }
  entries(): IterableIterator<[number, T]> {
    return [...this].entries();
  }
  // TODO: Implement support for RealmObjects, by comparing their #objectKey values
  includes(searchElement: T, fromIndex?: number): boolean {
    return [...this].includes(searchElement, fromIndex);
  }
  flatMap<U, This = undefined>(
    callback: (this: This, value: T, index: number, array: T[]) => U | readonly U[],
    thisArg?: This,
  ): U[] {
    return [...this].flatMap(callback, thisArg);
  }
  flat<A, D extends number = 1>(this: A, depth?: D): FlatArray<A, D>[];
  flat<D extends number = 1>(depth?: D): FlatArray<this, D>[] {
    throw new Error("Method not implemented.");
  }
  at(index: number) {
    return [...this].at(index);
  }

  [Symbol.iterator](): IterableIterator<T> {
    return this.values();
  }

  // Other methods

  /**
   * @returns An object for JSON serialization.
   */
  toJSON(): Array<unknown> {
    throw new Error("Method not implemented.");
  }

  description(): string {
    throw new Error("Method not implemented.");
  }

  isValid(): boolean {
    throw new Error(`Calling isValid on a ${this.constructor.name} is not support`);
  }

  isEmpty(): boolean {
    return this.results.size() === 0;
  }

  min(property?: string): number | Date | undefined {
    const columnKey = this.getPropertyColumnKey(property);
    const result = this.results.min(columnKey);
    if (result instanceof Date || typeof result === "number" || typeof result === "undefined") {
      return result;
    } else if (typeof result === "bigint") {
      return Number(result);
    } else if (result instanceof binding.Float) {
      return result.value;
    } else if (result instanceof binding.Timestamp) {
      return result.toDate();
    } else {
      throw new TypeAssertionError("Timestamp, number, bigint, Float or null", result, "result");
    }
  }
  max(property?: string): number | Date | undefined {
    const columnKey = this.getPropertyColumnKey(property);
    const result = this.results.max(columnKey);
    if (result instanceof Date || typeof result === "number" || typeof result === "undefined") {
      return result;
    } else if (typeof result === "bigint") {
      return Number(result);
    } else if (result instanceof binding.Float) {
      return result.value;
    } else if (result instanceof binding.Timestamp) {
      return result.toDate();
    } else {
      throw new TypeAssertionError("Timestamp, number, bigint, Float or undefined", result, "result");
    }
  }
  sum(property?: string): number {
    const columnKey = this.getPropertyColumnKey(property);
    const result = this.results.sum(columnKey);
    if (typeof result === "number") {
      return result;
    } else if (typeof result === "bigint") {
      return Number(result);
    } else if (result instanceof binding.Float) {
      return result.value;
    } else {
      throw new TypeAssertionError("number, bigint or Float", result, "result");
    }
  }
  avg(property?: string): number | undefined {
    const columnKey = this.getPropertyColumnKey(property);
    const result = this.results.average(columnKey);
    if (typeof result === "number" || typeof result === "undefined") {
      return result;
    } else if (typeof result === "bigint") {
      return Number(result);
    } else if (result instanceof binding.Float) {
      return result.value;
    } else {
      throw new TypeAssertionError("number, Float, bigint or undefined", result, "result");
    }
  }

  /**
   * @param  {string} query
   * @param  {any[]} ...arg
   * @returns Results
   */
  filtered(queryString: string, ...args: any[]): Results<T> {
    const { results: parent, realm, helpers } = this;
    const kpMapping = binding.Helpers.getKeypathMapping(realm.internal);
    // TODO: Perform a mapping of the arguments
    const query = parent.query.table.query(queryString, args, kpMapping);
    const results = parent.filter(query);
    return new Results(realm, results, helpers);
  }

  sorted(reverse?: boolean): Results<T>;
  sorted(descriptor: SortDescriptor[]): Results<T>;
  sorted(descriptor: string, reverse?: boolean): Results<T>;
  sorted(arg0: boolean | SortDescriptor[] | string = "self", arg1?: boolean): Results<T> {
    if (Array.isArray(arg0)) {
      const { results: parent, realm, helpers } = this;
      // Map optional "reversed" to "accending" (expected by the binding)
      const descriptors = arg0.map<[string, boolean]>((arg) =>
        typeof arg === "string" ? [arg, true] : [arg[0], !arg[1]],
      );
      // TODO: Call `parent.sort`, avoiding property name to colkey conversion to speed up performance here.
      const results = parent.sortByNames(descriptors);
      return new Results(realm, results, helpers);
    } else if (typeof arg0 === "string") {
      return this.sorted([[arg0, arg1 === true]]);
    } else if (typeof arg0 === "boolean") {
      return this.sorted([["self", arg0]]);
    } else {
      throw new Error("Expected either a property name and optional bool or an array of descriptors");
    }
  }

  /**
   * @returns Results
   */
  snapshot(): Results<T> {
    return new Results(this.realm, this.results.snapshot(), this.helpers);
  }

  private getPropertyColumnKey(name: string | undefined): binding.ColKey {
    if (this.classHelpers) {
      assert.string(name, "name");
      return this.classHelpers.properties.get(name).columnKey;
    } else if (name) {
      throw new Error(`Cannot get property named '${name}' on a list of primitives`);
    } else {
      return DEFAULT_COLUMN_KEY;
    }
  }
}