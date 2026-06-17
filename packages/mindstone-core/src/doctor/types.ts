export type MindStoneDoctorSeverity = "pass" | "warn" | "fail" | "info";

export type MindStoneDoctorCheck = {
  id: string;
  severity: MindStoneDoctorSeverity;
  title: string;
  detail?: string;
};

export type MindStoneDoctorReport = {
  ok: boolean;
  checks: MindStoneDoctorCheck[];
  summary: {
    pass: number;
    warn: number;
    fail: number;
    info: number;
  };
};
