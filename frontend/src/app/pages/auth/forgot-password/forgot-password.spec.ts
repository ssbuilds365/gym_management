import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { AuthService } from '../../../services/auth';
import { ForgotPassword } from './forgot-password';

describe('ForgotPassword', () => {
  let fixture: ComponentFixture<ForgotPassword>;
  let component: ForgotPassword;
  let forgotPassword: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    forgotPassword = vi.fn().mockReturnValue(of({
      success: true,
      message: 'If an account exists, a reset link will be sent.'
    }));
    await TestBed.configureTestingModule({
      imports: [ForgotPassword],
      providers: [
        provideRouter([]),
        { provide: AuthService, useValue: { forgotPassword } }
      ]
    }).compileComponents();
    fixture = TestBed.createComponent(ForgotPassword);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('submits the normalized email and shows the generic response', () => {
    component.form.controls.email.setValue(' owner@example.test ');
    component.submit();

    expect(forgotPassword).toHaveBeenCalledWith('owner@example.test');
    expect(component.successMessage).toContain('If an account exists');
  });
});
