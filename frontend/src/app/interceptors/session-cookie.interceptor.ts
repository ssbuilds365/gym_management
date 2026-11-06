import { HttpInterceptorFn } from '@angular/common/http';
import { environment } from '../../environments/environment';

export const sessionCookieInterceptor: HttpInterceptorFn = (request, next) => {
  const apiUrl = environment.apiUrl;
  const isApiRequest = request.url.startsWith(apiUrl);
  if (!isApiRequest) return next(request);

  return next(request.clone({
    withCredentials: true,
    headers: request.headers.delete('Authorization')
  }));
};
