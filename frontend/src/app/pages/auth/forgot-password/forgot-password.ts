import { CommonModule } from '@angular/common';
import { ChangeDetectorRef, Component } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterModule } from '@angular/router';
import { finalize } from 'rxjs';
import { AuthService } from '../../../services/auth';

@Component({
  selector: 'app-forgot-password',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule, RouterModule],
  templateUrl: './forgot-password.html',
  styleUrl: '../login/login.scss'
})
export class ForgotPassword {
  readonly form;
  loading = false;
  successMessage = '';
  errorMessage = '';

  constructor(
    formBuilder: FormBuilder,
    private readonly auth: AuthService,
    private readonly changeDetector: ChangeDetectorRef
  ) {
    this.form = formBuilder.nonNullable.group({
      email: ['', [Validators.required, Validators.email, Validators.maxLength(254)]]
    });
  }

  submit(): void {
    if (this.loading) return;
    this.successMessage = '';
    this.errorMessage = '';
    this.form.controls.email.setValue(this.form.controls.email.value.trim());
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }

    this.loading = true;
    this.auth.forgotPassword(this.form.controls.email.value.trim())
      .pipe(finalize(() => {
        this.loading = false;
        this.changeDetector.markForCheck();
      }))
      .subscribe({
        next: response => {
          this.successMessage = response.message ||
            'If an account exists for that email, a password reset link will be sent shortly.';
        },
        error: error => {
          this.errorMessage = error.error?.message ||
            'We could not process the reset request. Please try again later.';
        }
      });
  }
}
