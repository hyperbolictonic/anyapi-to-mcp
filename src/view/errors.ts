// Error values for the view layer.
//
// Codes are stable strings because an agent branches on them; messages are for
// humans. `hint` is the cheapest next call, in the same spirit as the result
// envelope's hint.

export type ViewErrorCode =
  | 'bad_address'
  | 'address_not_found'
  | 'not_an_array'
  | 'selector_needs_array'
  | 'selector_miss'
  | 'unknown_mode'
  | 'mode_shape_mismatch'
  | 'bad_view'
  | 'bad_join';

export type ViewError = {
  readonly code: ViewErrorCode;
  readonly message: string;
  readonly address?: string;
  readonly hint?: string;
};

export function viewError(code: ViewErrorCode, message: string, extra: { address?: string; hint?: string } = {}): ViewError {
  return {
    code,
    message,
    ...(extra.address === undefined ? {} : { address: extra.address }),
    ...(extra.hint === undefined ? {} : { hint: extra.hint }),
  };
}
