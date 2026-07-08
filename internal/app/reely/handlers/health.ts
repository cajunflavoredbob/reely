import type { Request, Response } from 'express';

export const handler = (_req: Request, res: Response): void => {
  res.status(200).send('reely is alive');
};
