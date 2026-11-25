import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { of, Subject, throwError } from 'rxjs';
import { AuthService } from '../../../services/auth';
import { Register } from './register';

describe('Register', () => {
  let component: Register;
  let fixture: ComponentFixture<Register>;
  let authService: { register: ReturnType<typeof vi.fn> };
  let router: Router;

  const validFormData = () => ({
    name: 'Owner Name',
    email: 'owner@example.com',
    phone: '9876543210',
    password: 'secure-password',
    businessName: 'Fitness Studio',
    businessType: 'Gym',
    address: 'Main Street'
  });

  beforeEach(async () => {
    authService = { register: vi.fn() };
    await TestBed.configureTestingModule({
      imports: [Register],
      providers: [
        provideRouter([]),
        { provide: AuthService, useValue: authService }
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(Register);
    component = fixture.componentInstance;
    router = TestBed.inject(Router);
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('shows field-level errors and does not submit an invalid form', () => {
    component.onSubmit();
    fixture.detectChanges();

    expect(authService.register).not.toHaveBeenCalled();
    expect(component.registerForm.controls['name'].touched).toBe(true);
    expect(fixture.nativeElement.textContent).toContain('Enter your name.');
    expect(fixture.nativeElement.textContent).toContain('Enter your email address.');
  });

  it('trims text fields and navigates to dashboard after successful registration', () => {
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    authService.register.mockReturnValue(of({
      success: true,
      session: { id: 'session-id' }
    }));
    component.registerForm.setValue({
      ...validFormData(),
      name: '  Owner Name  ',
      email: ' owner@example.com ',
      businessName: ' Fitness Studio ',
      address: ' Main Street '
    });

    component.onSubmit();

    expect(authService.register).toHaveBeenCalledWith({
      ...validFormData(),
      name: 'Owner Name',
      email: 'owner@example.com',
      businessName: 'Fitness Studio',
      address: 'Main Street'
    });
    expect(navigate).toHaveBeenCalledWith(['/dashboard']);
    expect(component.loading).toBe(false);
  });

  it('shows backend registration errors and clears the loading state', () => {
    authService.register.mockReturnValue(throwError(() => ({
      error: { message: 'An account with this email already exists' }
    })));
    component.registerForm.setValue(validFormData());

    component.onSubmit();
    fixture.detectChanges();

    expect(component.errorMessage).toBe('An account with this email already exists');
    expect(component.loading).toBe(false);
  });

  it('ignores repeated submits while a request is in progress', () => {
    const registrationResult = new Subject<any>();
    authService.register.mockReturnValue(registrationResult);
    component.registerForm.setValue(validFormData());

    component.onSubmit();
    component.onSubmit();

    expect(authService.register).toHaveBeenCalledTimes(1);
    expect(component.loading).toBe(true);
    registrationResult.next({ success: false, message: 'Registration failed' });
    registrationResult.complete();
    expect(component.loading).toBe(false);
  });
});
