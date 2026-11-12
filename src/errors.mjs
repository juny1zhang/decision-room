/** An error whose message can be shown to the user, with the HTTP status to answer with. */
export class AppError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}
