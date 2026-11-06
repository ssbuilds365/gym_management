import { ChangeDetectorRef, Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  FormBuilder,
  FormGroup,
  Validators,
  ReactiveFormsModule
} from '@angular/forms';
import { Router, RouterModule } from '@angular/router';
import { AuthService } from '../../../services/auth';
import { finalize } from 'rxjs';

@Component({
  selector: 'app-register',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule, RouterModule],
  templateUrl: './register.html',
  styleUrl: './register.scss'
})
export class Register {

  registerForm: FormGroup;
  loading = false;
  errorMessage = '';

  businessTypes = [
    'Gym',
    'Yoga Studio',
    'Fitness Studio',
    'Other'
  ];

  constructor(
    private fb: FormBuilder,
    private authService: AuthService,
    private router: Router,
    private changeDetector: ChangeDetectorRef
  ) {
    this.registerForm = this.fb.group({
      name: ['', Validators.required],
      email: ['', [Validators.required, Validators.email]],
      phone: ['', [
        Validators.required,
        Validators.pattern(/^[0-9]{10}$/)
      ]],
      password: ['', [
        Validators.required,
        Validators.minLength(8)
      ]],
      businessName: ['', Validators.required],
      businessType: ['Gym', Validators.required],
      address: ['']
    });
  }

  onSubmit(): void {
    if (this.loading) return;
    this.errorMessage = '';

    if (this.registerForm.invalid) {
      this.registerForm.markAllAsTouched();
      return;
    }

    this.loading = true;

    this.authService.register(this.registerForm.value)
      .pipe(finalize(() => {
        this.loading = false;
        this.changeDetector.markForCheck();
      }))
      .subscribe({
      next: (response) => {
        if (response.success && response.session?.id) {
          this.router.navigate(['/dashboard']);
        } else {
          this.errorMessage = response.message || 'Registration failed';
        }
      },
      error: (error) => {
        this.errorMessage =
          error.error?.message || 'Something went wrong. Please try again.';
      }
    });
  }
}