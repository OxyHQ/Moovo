import { Package, UtensilsCrossed, Truck, type LucideIcon } from 'lucide-react-native';
import type { ShipmentType } from '@moovo/shared-types';

/**
 * Per-shipment-type presentation metadata (icon, labels, field copy).
 *
 * Centralizes the package / food / move differences so the type picker, parcel
 * step, list rows and headers stay consistent. The parcel step adapts its labels
 * and the description prompt per type from this single table.
 */
export interface ShipmentTypeMeta {
  type: ShipmentType;
  /** Short title (e.g. "Package"). */
  label: string;
  /** One-line description of what this type is for. */
  description: string;
  /** Lucide icon for the type. */
  icon: LucideIcon;
  /** Prompt for the free-text contents field. */
  itemPrompt: string;
  /** Label for the "what are you sending" contents field. */
  itemLabel: string;
}

export const SHIPMENT_TYPES: Record<ShipmentType, ShipmentTypeMeta> = {
  package: {
    type: 'package',
    label: 'Package',
    description: 'Send a parcel or documents',
    icon: Package,
    itemLabel: 'What are you sending?',
    itemPrompt: 'e.g. A small box of books',
  },
  food: {
    type: 'food',
    label: 'Food',
    description: 'Order or send a food delivery',
    icon: UtensilsCrossed,
    itemLabel: 'What food is it?',
    itemPrompt: 'e.g. Two pizzas, kept upright',
  },
  move: {
    type: 'move',
    label: 'Move',
    description: 'Move furniture or larger items',
    icon: Truck,
    itemLabel: 'What are you moving?',
    itemPrompt: 'e.g. A two-seater sofa and a chair',
  },
};

/** Ordered list of types for pickers. */
export const SHIPMENT_TYPE_ORDER: ShipmentType[] = ['package', 'food', 'move'];
