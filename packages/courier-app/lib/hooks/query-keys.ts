export const queryKeys = {
  notifications: {
    all: ["notifications"] as const,
  },
  courier: {
    me: ["courier", "me"] as const,
  },
  jobs: {
    courier: ["jobs", "courier"] as const,
  },
} as const;
