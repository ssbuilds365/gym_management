import { HttpInterceptorFn } from '@angular/common/http';
import { environment } from '../../environments/environment';

export const sessionCookieInterceptor: HttpInterceptorFn = (request, next) => {
  const apiUrl = environment.apiUrl;
  const isApiRequest = request.url.startsWith(apiUrl);
  if (!isApiRequest) return next(request);

  const isKioskRequest = request.url.startsWith(`${apiUrl}/kiosk/`);
  return next(request.clone({
    withCredentials: true,
    headers: isKioskRequest
      ? request.headers
      : request.headers.delete('Authorization')
  }));
};
