import { Hono } from 'hono'
import { Buffer } from "buffer";
import { z } from 'zod';
import { validator } from 'hono/validator';
import { createHmac } from 'node:crypto';
import { cors } from 'hono/cors';

// Encode string to base64token format.
const encode = (str: string): string => Buffer.from(str, 'binary').toString('base64');

type Bindings = {
  RZRP_KEY_ID: string,
  RZRP_KEY_SECRET: string
}

const app = new Hono<{ Bindings: Bindings }>()

app.use('*', cors());

const orderSchema = z.object({
  amount: z.number(),
  receipt: z.string().optional(),
  notes: z.record(z.string(), z.string()).optional(),
})

app.post(
  '/create-order',
  validator('json', (value, c) => {
    const parsed = orderSchema.safeParse(value);
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

    let res = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      body: JSON.stringify(reqBody),
      headers: {
        "Content-Type": "application/json",
        'Authorization': `Basic ${encode(`${c.env.RZRP_KEY_ID}:${c.env.RZRP_KEY_SECRET}`)}`
      }
    });

    let jsn: any = await res.json();

    return c.json(jsn)
  })

const toValidateSchema = z.object({
  orderId: z.string(),
  paymentId: z.string(),
  signature: z.string(),
})

app.post(
  '/verify-payment', 
  validator('json', (value, c) => {
    const parsed = toValidateSchema.safeParse(value);
    if (!parsed.success) {
      return c.text('Invalid!', 401)
    }
    return parsed.data
  }),
  async (c) => {
  const { orderId, paymentId, signature } = c.req.valid('json');

  const hmac = createHmac('sha256', c.env.RZRP_KEY_SECRET);

  hmac.update(orderId + "|" + paymentId);

  const generatedHash = hmac.digest('hex')

  const isValid = generatedHash == signature

  return c.json({ isValid });
});

export default app
