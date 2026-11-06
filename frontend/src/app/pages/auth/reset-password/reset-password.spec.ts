import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, provideRouter, Router } from '@angular/router';
import { of } from 'rxjs';
import { AuthService } from '../../../services/auth';
import { ResetPassword } from './reset-password';

describe('ResetPassword', () => {
  let fixture: ComponentFixture<ResetPassword>;
  let component: ResetPassword;
  let resetPassword: ReturnType<typeof vi.fn>;
  let navigate: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    resetPassword = vi.fn().mockReturnValue(of({ success: true }));
    navigate = vi.fn();
    await TestBed.configureTestingModule({
      imports: [ResetPassword],
      providers: [
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { queryParamMap: { get: () => 'a'.repeat(64) } } }
        },
        { provide: Router, useValue: { navigate } },
        {
          provide: AuthService,
          useValue: {
            validateResetToken: vi.fn().mockReturnValue(of({ valid: true })),
            resetPassword
          }
        }
      ]
    }).compileComponents();
    fixture = TestBed.createComponent(ResetPassword);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('validates the token and submits a matching new password', () => {
    component.form.setValue({
      newPassword: 'NewPassword2!',
      confirmPassword: 'NewPassword2!'
    });

    component.submit();

    expect(resetPassword).toHaveBeenCalledWith({
      token: 'a'.repeat(64),
      newPassword: 'NewPassword2!',
      confirmPassword: 'NewPassword2!'
    });
    expect(navigate).toHaveBeenCalledWith(['/login'], {
      queryParams: { reset: 'success' },
      replaceUrl: true
    });
  });

  it('rejects mismatching confirmation without calling reset API', () => {
    component.form.setValue({
      newPassword: 'NewPassword2!',
      confirmPassword: 'DifferentPassword3!'
    });

    component.submit();

    expect(component.errorMessage).toContain('do not match');
    expect(resetPassword).not.toHaveBeenCalled();
  });
});
