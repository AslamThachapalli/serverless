import { Hono } from 'hono'
import { Buffer } from "buffer";
import { env } from 'hono/adapter';
import { z } from 'zod';
import { validator } from 'hono/validator';

// Encode string to base64token format.
const encode = (str: string): string => Buffer.from(str, 'binary').toString('base64');

const app = new Hono()

const schema = z.object({
  amount: z.number(),
  receipt: z.string().optional(),
  notes: z.record(z.string(), z.string()).optional(),
})

app.post(
  '/order',
  validator('json', (value, c) => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      return c.text('Invalid!', 401)
    }
    return parsed.data
  }),
  async (c) => {
    const body = c.req.valid('json')

    const reqBody = {
      ...body,
      'currency': 'INR'
    }

    const { RZRP_KEY_ID, RZRP_KEY_SECRET } = env<{ RZRP_KEY_ID: string, RZRP_KEY_SECRET: string }>(c);

    let res = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      body: JSON.stringify(reqBody),
      headers: {
        "Content-Type": "application/json",
        'Authorization': `Basic ${encode(`${RZRP_KEY_ID}:${RZRP_KEY_SECRET}`)}`
      }
    });

    let jsn: any = await res.json();

    return c.json(jsn)
  })

export default app
