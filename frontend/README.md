# Frontend

This project was generated using [Angular CLI](https://github.com/angular/angular-cli) version 22.0.1.

## Development server

To start a local development server, run:

```bash
ng serve
```

Once the server is running, open your browser and navigate to `http://localhost:4200/`. The application will automatically reload whenever you modify any of the source files.

## Code scaffolding

Angular CLI includes powerful code scaffolding tools. To generate a new component, run:

```bash
ng generate component component-name
```

For a complete list of available schematics (such as `components`, `directives`, or `pipes`), run:

```bash
ng generate --help
```

## Building

To build the project run:

```bash
npm run build
```

This will compile your project and store the build artifacts in the `dist/` directory. By default, the production build optimizes your application for performance and speed.

## Environment configuration and deployment

Angular services read their API base URL from `src/environments/environment.ts`.
Development uses `environment.development.ts`. Production builds replace it
with `environment.production.ts`; production URL and public integration values
must be configured before deployment.

For Vercel, set the project root to `frontend`. The included `vercel.json`
builds the Angular application and rewrites client-side routes to `index.html`.
Vercel build-time public variables override the production defaults:

| Vercel variable | Purpose |
| --- | --- |
| `NG_APP_FRONTEND_URL` | Deployed frontend origin |
| `NG_APP_BACKEND_URL` | Render backend origin |
| `NG_APP_API_URL` | Render API base URL, including `/api` |
| `NG_APP_RAZORPAY_KEY_ID` | Public Razorpay key ID, if used |
| `NG_APP_CLOUDINARY_CLOUD_NAME` | Cloudinary cloud name, if used |
| `NG_APP_CLOUDINARY_UPLOAD_PRESET` | Unsigned upload preset, if used |
| `NG_APP_NAME` | Public application name (optional) |
| `NG_APP_VERSION` | Public application version (optional) |

These values are compiled into the browser bundle and must never contain
secrets. Razorpay secrets, Cloudinary API secrets, JWT secrets, and MongoDB
credentials belong only in the backend environment. The frontend build script
generates a git-ignored production configuration from these Vercel variables;
without them, production values remain empty and must be supplied in the
production environment configuration.

For Render, set the backend root directory to `backend` and configure the
variables documented in `../backend/.env.example` in the Render service settings.
Do not upload or commit a local `.env` file.

## Running unit tests

To execute unit tests with the [Vitest](https://vitest.dev/) test runner, use the following command:

```bash
ng test
```

## Running end-to-end tests

For end-to-end (e2e) testing, run:

```bash
ng e2e
```

Angular CLI does not come with an end-to-end testing framework by default. You can choose one that suits your needs.

## Additional Resources

For more information on using the Angular CLI, including detailed command references, visit the [Angular CLI Overview and Command Reference](https://angular.dev/tools/cli) page.
