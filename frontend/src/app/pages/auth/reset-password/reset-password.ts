import { CommonModule } from '@angular/common';
import { ChangeDetectorRef, Component, OnInit } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { finalize } from 'rxjs';
import { AuthService } from '../../../services/auth';

@Component({
  selector: 'app-reset-password',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule, RouterModule],
  templateUrl: './reset-password.html',
  styleUrl: '../login/login.scss'
})
export class ResetPassword implements OnInit {
  readonly form;
  token = '';
  validating = true;
  validToken = false;
  loading = false;
  showNewPassword = false;
  showConfirmPassword = false;
  errorMessage = '';

  constructor(
    formBuilder: FormBuilder,
    private readonly auth: AuthService,
    private readonly route: ActivatedRoute,
    private readonly router: Router,
    private readonly changeDetector: ChangeDetectorRef
  ) {
    this.form = formBuilder.nonNullable.group({
      newPassword: ['', [Validators.required, Validators.minLength(8)]],
      confirmPassword: ['', Validators.required]
    });
  }

  ngOnInit(): void {
    this.token = this.route.snapshot.queryParamMap.get('token') || '';
    if (this.token && typeof window !== 'undefined') {
      window.history.replaceState(window.history.state, '', '/reset-password');
    }
    if (!this.token) {
      this.validating = false;
      this.errorMessage = 'This reset link is invalid or expired. Request a new link.';
      return;
    }

    this.auth.validateResetToken(this.token)
      .pipe(finalize(() => {
        this.validating = false;
        this.changeDetector.markForCheck();
      }))
      .subscribe({
        next: response => {
          this.validToken = response?.valid === true;
          if (!this.validToken) {
            this.errorMessage = 'This reset link is invalid, expired, or already used. Request a new link.';
          }
        },
        error: error => {
          this.errorMessage = error.error?.message ||
            'Unable to verify this reset link right now.';
        }
      });
  }

  get passwordStrength(): number {
    const password = this.form.controls.newPassword.value;
    if (!password) return 0;
    return [
      password.length >= 8,
      password.length >= 12,
      /[a-z]/.test(password) && /[A-Z]/.test(password),
      /\d/.test(password) && /[^A-Za-z0-9]/.test(password)
    ].filter(Boolean).length;
  }

  get passwordStrengthLabel(): string {
    if (!this.form.controls.newPassword.value) return 'Not entered';
    return ['Weak', 'Weak', 'Fair', 'Good', 'Strong'][this.passwordStrength];
  }

  submit(): void {
    if (this.loading || !this.validToken) return;
    this.errorMessage = '';
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    if (new TextEncoder().encode(this.form.controls.newPassword.value).length > 72) {
      this.errorMessage = 'Password must be 72 bytes or fewer.';
      return;
    }
    if (this.form.controls.newPassword.value !== this.form.controls.confirmPassword.value) {
      this.errorMessage = 'New password and confirmation do not match.';
      return;
    }

    this.loading = true;
    this.auth.resetPassword({
      token: this.token,
      ...this.form.getRawValue()
    }).pipe(finalize(() => {
      this.loading = false;
      this.changeDetector.markForCheck();
    }))
      .subscribe({
        next: () => this.router.navigate(['/login'], {
          queryParams: { reset: 'success' },
          replaceUrl: true
        }),
        error: error => {
          this.validToken = false;
          this.errorMessage = error.error?.message ||
            'Unable to reset your password. Request a new reset link.';
        }
      });
  }
}
