import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import AsyncStorage from "@react-native-async-storage/async-storage";

/**
 * Persisted selection of the active company for the Moovo Hub dashboard. An
 * operator may belong to several companies; the selected id is remembered across
 * sessions so the dashboard reopens on the company they were last managing.
 */
interface CompanyStoreState {
  /** The currently-selected company id, or `null` when none is chosen yet. */
  selectedCompanyId: string | null;
  /** Select a company (or clear the selection with `null`). */
  setSelectedCompanyId: (companyId: string | null) => void;
}

export const useCompanyStore = create<CompanyStoreState>()(
  persist(
    (set) => ({
      selectedCompanyId: null,
      setSelectedCompanyId: (companyId) =>
        set({ selectedCompanyId: companyId }),
    }),
    {
      name: "moovo-hub-company",
      storage: createJSONStorage(() => AsyncStorage),
    },
  ),
);
