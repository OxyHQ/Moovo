export const queryKeys = {
  notifications: {
    all: ["notifications"] as const,
  },
  courier: {
    me: ["courier", "me"] as const,
    vehicles: ["courier", "vehicles"] as const,
  },
  jobs: {
    courier: ["jobs", "courier"] as const,
    detail: (id: string) => ["jobs", "detail", id] as const,
  },
} as const;
