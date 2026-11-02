// The map format.
//
// A map is configuration, not code. It describes resources, the operations on
// them, the links between them, and how each response should be presented. It
// never contains a credential, an expression or a function.
//
// `schemaVersion: 2` is this format. Version 1 is the legacy wrapper
// and recipe format, which is projected into this shape on load rather than
// rewritten on disk.

import type { Provenance, ViewSpec } from '../view/types.ts';

export const MAP_SCHEMA_VERSION = 2;

export type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type Resource = {
  readonly id: string;
  readonly title: string;
  /** Field that identifies a row of this resource, used for keyed addresses. */
  readonly key?: string;
};

export type InputProperty = {
  readonly type: 'string' | 'integer' | 'number' | 'boolean';
  readonly description?: string;
  readonly enum?: readonly (string | number | boolean)[];
  readonly default?: string | number | boolean;
  readonly minimum?: number;
  readonly maximum?: number;
  /** Declared here, valued at call time; an array becomes repeated query keys. */
  readonly repeated?: boolean;
};

export type RequestTemplate = {
  readonly method: HttpMethod;
  readonly path: string;
  /** Values are templates: `/repos/{owner}/{repo}`. A value may be `{name}`. */
  readonly query?: Readonly<Record<string, string>>;
  /** Never a credential. A literal `authorization` header is a validation error. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
};

export type Pagination =
  | { readonly kind: 'none' }
  | { readonly kind: 'link-header'; readonly rel?: string }
  | {
      readonly kind: 'offset';
      readonly totalPath: string;
      readonly skipPath: string;
      readonly limitPath: string;
    };

export type Operation = {
  readonly id: string;
  /** The resource the operation is called on. */
  readonly resource: string;
  /** The resource it produces. Defaults to `resource` when omitted. */
  readonly returns?: string;
  readonly title: string;
  readonly description?: string;
  readonly mutating?: boolean;
  readonly provenance?: Provenance;
  readonly request: RequestTemplate;
  readonly input?: {
    readonly required?: readonly string[];
    readonly properties?: Readonly<Record<string, InputProperty>>;
  };
  readonly pagination?: Pagination;
  /** Primary view. Named alternates live in `views`. */
  readonly view?: ViewSpec;
  readonly views?: Readonly<Record<string, ViewSpec>>;
  /**
   * The *name* of a secret binding this operation needs. The value is supplied
   * by a SecretProvider and its host affinity by a human-authored binding; a
   * map can never widen where a secret may be sent.
   */
  readonly secret?: string;
};

export type Link = {
  readonly from: string;
  readonly field: string;
  readonly to: string;
  readonly operation: string;
  readonly argument: string;
  readonly provenance?: Provenance;
};

/**
 * Whether an operation changes data.
 *
 * Derived from the method as well as declared, because forgetting
 * `mutating: true` on a hand-written POST would otherwise let a pin replay a
 * write, and would remove the only warning an agent gets before `run`.
 */
export function isMutating(operation: Operation): boolean {
  return operation.mutating === true || (operation.request.method !== 'GET' && operation.request.method !== 'HEAD');
}

export type MapDocument = {
  readonly schemaVersion: typeof MAP_SCHEMA_VERSION;
  readonly id: string;
  readonly title: string;
  readonly baseUrl: string;
  readonly description?: string;
  readonly provenance?: { readonly source: Provenance; readonly date?: string };
  readonly resources: readonly Resource[];
  readonly operations: readonly Operation[];
  readonly links?: readonly Link[];
};

export type MapIssue = {
  readonly path: string;
  readonly message: string;
  readonly severity: 'error' | 'warning';
};

/** Find an operation by id. Ids are unique across a map (enforced by
 * validation), so this is a lookup, not a search. */
export function findOperationIn(map: MapDocument, id: string): Operation | undefined {
  return map.operations.find((operation) => operation.id === id);
}

export function resourceOf(map: MapDocument, id: string): Resource | undefined {
  return map.resources.find((resource) => resource.id === id);
}

/** The operations that touch a resource, in either direction. */
export function operationsFor(map: MapDocument, resourceId: string): readonly Operation[] {
  return map.operations.filter((operation) => operation.resource === resourceId || operation.returns === resourceId);
}
