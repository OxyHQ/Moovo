# @moovo/shared-types

Shared TypeScript types for the Moovo monorepo. Imported by both
`@moovo/frontend` and `@moovo/backend` so the API contract lives in a
single place.

## Contents

- **`common`** — `ApiResponse<T>`, `PaginatedResponse<T>`, `Pagination`,
  `PaginationParams`, `Timestamps`, and utility types (`Optional`,
  `RequiredFields`, `DeepPartial`).
- **`money`** — `Money` (integer minor units) and `CurrencyCode`.
- **`seller`** — `Seller` public identity DTO.
- **`listing`** — `Listing` domain entity plus `ListingCondition`
  (`new` | `used`), `ListingStatus`, `ListingImage`, and the
  `CreateListingInput` / `UpdateListingInput` / `ListingQuery` request shapes.

## Usage

```ts
import type { Listing, ApiResponse } from '@moovo/shared-types';
```

## Build

```bash
bun run build   # tsc -> dist/ (dist/index.js + dist/index.d.ts)
```

The compiled output is consumed by the backend (Node/Bun) and the frontend
(Metro/Expo) alike.
