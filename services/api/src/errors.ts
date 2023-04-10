import type {NextFunction, Request, RequestHandler, Response} from 'express';

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function route(handler: (request: Request, response: Response, next: NextFunction) => Promise<unknown>): RequestHandler {
  return (request, response, next) => {
    void handler(request, response, next).catch(next);
  };
}
