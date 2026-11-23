import { environment as development } from './environment.development';
import { environment as production } from './environment.production';

describe('API environment configuration', () => {
  it('uses the Render API directly in production', () => {
    expect(production.apiUrl).toBe('https://gym-management-llv3.onrender.com/api');
  });

  it('preserves the local API base for development', () => {
    expect(development.apiUrl).toBe('http://localhost:5000/api');
  });
});
