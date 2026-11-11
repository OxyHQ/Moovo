import type { JobStatus } from '@moovo/shared-types';
import { Chip } from '@oxy.so/bloom/chip';
import { useTranslation } from '@moovo/app-shell/hooks/useTranslation';
import { jobStatusKey } from '@/lib/format';

/** A job-status chip: live stages are the brand tone, `delivered` is success, `cancelled` is error. */
const STATUS_COLOR: Record<JobStatus, 'default' | 'primary' | 'success' | 'error'> = {
  requested: 'default',
  offered: 'primary',
  accepted: 'primary',
  picked_up: 'primary',
  in_transit: 'primary',
  delivered: 'success',
  cancelled: 'error',
};

export function StatusChip({ status }: { status: JobStatus }) {
  const { t } = useTranslation();
  return (
    <Chip variant="subtle" color={STATUS_COLOR[status]}>
      {t(jobStatusKey(status))}
    </Chip>
  );
}
