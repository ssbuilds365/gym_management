import { ChangeDetectorRef, Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  FormBuilder,
  FormGroup,
  Validators,
  ReactiveFormsModule
} from '@angular/forms';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { AuthService } from '../../../services/auth';
import { finalize } from 'rxjs';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule, RouterModule],
  templateUrl: './login.html',
  styleUrl: './login.scss'
})
export class Login {

  loginForm: FormGroup;
  loading = false;
  errorMessage = '';
  successMessage = '';

  constructor(
    private fb: FormBuilder,
    private authService: AuthService,
    private router: Router,
    private route: ActivatedRoute,
    private changeDetector: ChangeDetectorRef
  ) {
    const reason = this.route.snapshot.queryParamMap.get('reason');
    if (reason === 'inactive') {
      this.successMessage = 'You have been logged out due to inactivity.';
    } else if (reason === 'expired') {
      this.successMessage = 'Your session has expired. Please log in again.';
    } else if (reason === 'revoked') {
      this.successMessage = 'This session is no longer active. Please log in again.';
    } else if (reason === 'required') {
      this.successMessage = 'Your login session is unavailable. Please sign in again.';
    } else if (reason === 'password-changed') {
      this.successMessage = 'Your password was changed. Sign in with your new password.';
    }
    if (this.route.snapshot.queryParamMap.get('reset') === 'success') {
      this.successMessage = 'Password reset successfully. Sign in with your new password.';
    }
    this.loginForm = this.fb.group({
      email: ['', [Validators.required, Validators.email]],
      password: ['', Validators.required]
    });
  }

  onSubmit(): void {
    if (this.loading) return;

    this.errorMessage = '';
    this.successMessage = '';

    if (this.loginForm.invalid) {
      this.loginForm.markAllAsTouched();
      return;
    }

    this.loading = true;

    this.authService.login(this.loginForm.value)
      .pipe(finalize(() => {
        this.loading = false;
        this.changeDetector.markForCheck();
      }))
      .subscribe({

      next: (response) => {
        if (response.success && response.session?.id) {
          this.successMessage = 'Login successful!';
          this.router.navigate(['/dashboard']);
        } else {
          this.errorMessage = response.message || 'Login failed.';
        }

      },

      error: (error) => {
        this.errorMessage =
          error.error?.message || 'Invalid email or password.';

      }

    });

  }

}