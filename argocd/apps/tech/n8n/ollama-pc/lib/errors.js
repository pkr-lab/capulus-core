'use strict';

class OllamaPcError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'OllamaPcError';
    this.code = code;
    this.details = details;
  }
}

module.exports = { OllamaPcError };
