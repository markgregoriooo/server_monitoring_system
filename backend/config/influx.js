import "./env.js";
import { InfluxDB, Point } from '@influxdata/influxdb-client';

const url = process.env.INFLUX_URL;
const token = process.env.INFLUX_TOKEN;
const org = process.env.INFLUX_ORG;
const bucket = process.env.INFLUX_BUCKET;

// Transport timeout (default 10s), so a hung InfluxDB cannot hold an ingest path
// open forever. Every write path awaits flush().
const client = new InfluxDB({
  url,
  token,
  timeout: Number(process.env.INFLUX_TIMEOUT_MS) || 10_000,
});

const writeClient = client.getWriteApi(org, bucket, "ms");
const queryClient = client.getQueryApi(org);

// Export
export { writeClient, queryClient, Point, bucket };



