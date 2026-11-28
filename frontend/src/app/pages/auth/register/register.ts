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
    'Personal Trainer',
    'Other'
  ];

  constructor(
    private fb: FormBuilder,
    private authService: AuthService,
    private router: Router,
    private changeDetector: ChangeDetectorRef
  ) {
    this.registerForm = this.fb.group({
      name: ['', [Validators.required, Validators.pattern(/\S/)]],
      email: ['', [Validators.required, Validators.email]],
      phone: ['', [
        Validators.required,
        Validators.pattern(/^[0-9]{10}$/)
      ]],
      password: ['', [
        Validators.required,
        Validators.minLength(8)
      ]],
      businessName: ['', [Validators.required, Validators.pattern(/\S/)]],
      businessType: ['Gym', Validators.required],
      address: ['']
    });
  }

  hasFieldError(controlName: string): boolean {
    const control = this.registerForm.get(controlName);
    return !!control && control.touched && control.invalid;
  }

  onSubmit(): void {
    if (this.loading) return;
    this.errorMessage = '';
    this.trimTextFields();

    if (this.registerForm.invalid) {
      this.registerForm.markAllAsTouched();
      return;
    }

    this.loading = true;
    const formValue = this.registerForm.getRawValue();
    const registrationData = {
      ...formValue,
      name: formValue.name.trim(),
      email: formValue.email.trim(),
      phone: formValue.phone.trim(),
      businessName: formValue.businessName.trim(),
      address: formValue.address.trim()
    };

    this.authService.register(registrationData)
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

  private trimTextFields(): void {
    for (const controlName of ['name', 'email', 'phone', 'businessName', 'address']) {
      const control = this.registerForm.get(controlName);
      if (typeof control?.value === 'string') {
        control.setValue(control.value.trim(), { emitEvent: false });
      }
    }
  }
}