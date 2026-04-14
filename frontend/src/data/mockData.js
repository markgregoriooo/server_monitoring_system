export const servers = [
  { id: 1, name: "Server 1", status: "Online", cpu: 35, memory: 54, uptime: "15 days", ip: "192.168.1.101" },
  { id: 2, name: "Server 2", status: "Online", cpu: 52, memory: 67, uptime: "12 days", ip: "192.168.1.102" },
  { id: 3, name: "Server 3", status: "Online", cpu: 28, memory: 49, uptime: "20 days", ip: "192.168.1.103" },
];

export const alerts = [
  { id: 1, type: "warning", title: "High Temperature", desc: "Server Room",    time: "10:32 AM" },
  { id: 2, type: "warning", title: "CPU Usage High",   desc: "Server 2",       time: "09:45 AM" },
  { id: 3, type: "info",    title: "Aircon Turned ON", desc: "Auto Control",   time: "09:30 AM" },
  { id: 4, type: "info",    title: "Server 3 Rebooted",desc: "Scheduled",      time: "08:00 AM" },
];

export const environmentLogs = [
  { time: "10:00", temperature: 24.1, humidity: 62 },
  { time: "10:10", temperature: 24.8, humidity: 63 },
  { time: "10:20", temperature: 25.5, humidity: 65 },
  { time: "10:30", temperature: 26.1, humidity: 67 },
  { time: "10:40", temperature: 26.8, humidity: 70 },
  { time: "10:50", temperature: 27.2, humidity: 72 },
  { time: "11:00", temperature: 26.8, humidity: 71 },
  { time: "11:10", temperature: 26.3, humidity: 69 },
  { time: "11:20", temperature: 25.9, humidity: 68 },
  { time: "11:30", temperature: 25.4, humidity: 66 },
];

export const historyLogs = [
  { date: "2025-03-12", avgTemp: 26.2, maxTemp: 28.1, minTemp: 24.0, avgHum: 69, events: 3 },
  { date: "2025-03-11", avgTemp: 25.8, maxTemp: 27.5, minTemp: 23.5, avgHum: 67, events: 1 },
  { date: "2025-03-10", avgTemp: 27.1, maxTemp: 29.0, minTemp: 25.2, avgHum: 72, events: 5 },
  { date: "2025-03-09", avgTemp: 24.9, maxTemp: 26.3, minTemp: 23.1, avgHum: 65, events: 0 },
  { date: "2025-03-08", avgTemp: 26.5, maxTemp: 28.4, minTemp: 24.8, avgHum: 70, events: 2 },
];

export const reports = [
  { id: 1, title: "Daily Temperature Report", date: "2025-03-12", status: "Generated", type: "Environment" },
  { id: 2, title: "Weekly Server Metrics",    date: "2025-03-10", status: "Generated", type: "Server"      },
  { id: 3, title: "Monthly Uptime Summary",   date: "2025-03-01", status: "Generated", type: "Server"      },
  { id: 4, title: "Alert History Report",     date: "2025-03-12", status: "Pending",   type: "Alerts"      },
];

export const airconDefault = { enabled: true, mode: "Auto", setTemp: 24 };
