import { environment as development } from './environment.development';
import { environment as production } from './environment.production';

describe('API environment configuration', () => {
  it('uses the same-origin Vercel proxy in production', () => {
    expect(production.apiUrl).toBe('/api');
    expect(production.backendUrl).toBe('https://gym-management-llv3.onrender.com');
  });

  it('preserves the local API base for development', () => {
    expect(development.apiUrl).toBe('http://localhost:5000/api');
  });
});
