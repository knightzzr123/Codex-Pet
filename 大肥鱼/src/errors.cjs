// Errors whose message is written for the user. The settings window shows this
// copy as-is; anything else that reaches an import result is a technical detail
// (Node fs, a parser, a library) and is replaced by the code's own wording and
// written to the diagnostic log instead. Marking the errors at their source is
// what makes that split reliable: a Node fs error message can contain a Chinese
// path, so looking at the message is not enough to decide it is ours.
class UserFacingError extends Error {
  constructor(message, code = 'PACK_INVALID') {
    super(message);
    this.name = 'UserFacingError';
    this.code = code;
    this.userFacing = true;
  }
}

function userError(message, code) {
  return new UserFacingError(message, code);
}

function isUserFacingError(error) {
  return Boolean(error) && (error instanceof UserFacingError || error.userFacing === true);
}

module.exports = { UserFacingError, userError, isUserFacingError };
