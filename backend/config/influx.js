import "./env.js";
import { InfluxDB, Point } from '@influxdata/influxdb-client';

const url = process.env.INFLUX_URL;
const token = process.env.INFLUX_TOKEN;
const org = process.env.INFLUX_ORG;
const bucket = process.env.INFLUX_BUCKET;

const client = new InfluxDB({ url, token });

const writeClient = client.getWriteApi(org, bucket, "ms");
const queryClient = client.getQueryApi(org);

// Export
export { writeClient, queryClient, Point, bucket };



