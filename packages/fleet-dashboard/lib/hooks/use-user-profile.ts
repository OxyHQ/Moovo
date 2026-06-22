import { useQuery } from "@tanstack/react-query";
import { useOxy } from "@oxyhq/services";
import type { User } from "@oxyhq/core";

/**
 * Resolve an Oxy user profile by id, cached by TanStack Query.
 *
 * Company members, couriers and job parties are stored as bare `oxyUserId`s; the
 * canonical `name.displayName`, `username` and `avatar` are read live from Oxy
 * (the identity contract — never recomputed locally). Member lists are small and
 * the cache dedupes repeated ids across screens, so a per-id query is both clean
 * and efficient. Profiles change rarely, so they are cached generously.
 */
export function useUserProfile(oxyUserId: string | undefined) {
  const { oxyServices, canUsePrivateApi } = useOxy();

  return useQuery<User>({
    queryKey: ["oxy-profile", oxyUserId],
    queryFn: () => oxyServices.getUserById(oxyUserId as string),
    enabled: canUsePrivateApi && !!oxyUserId,
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
  });
}
