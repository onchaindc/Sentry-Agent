use odra::casper_types::U512;
use odra::prelude::*;

#[odra::module(events = [ApprovedSpend, BlockedSpend])]
pub struct SpendGuardrail {
    owner: Var<Address>,
    per_call_cap: Var<U512>,
    total_approved: Var<U512>,
}

#[odra::event]
pub struct ApprovedSpend {
    pub amount: U512,
    pub result: bool,
}

#[odra::event]
pub struct BlockedSpend {
    pub amount: U512,
    pub result: bool,
}

#[odra::odra_error]
pub enum Error {
    NotOwner = 1,
}

#[odra::module]
impl SpendGuardrail {
    pub fn init(&mut self, per_call_cap: U512) {
        self.owner.set(self.env().caller());
        self.per_call_cap.set(per_call_cap);
        self.total_approved.set(U512::zero());
    }

    pub fn set_cap(&mut self, new_cap: U512) {
        self.ensure_owner();
        self.per_call_cap.set(new_cap);
    }

    pub fn check_and_record(&mut self, amount: U512) -> bool {
        if amount <= self.per_call_cap.get_or_default() {
            let next_total = self.total_approved.get_or_default() + amount;
            self.total_approved.set(next_total);
            self.env().emit_event(ApprovedSpend {
                amount,
                result: true,
            });
            true
        } else {
            self.env().emit_event(BlockedSpend {
                amount,
                result: false,
            });
            false
        }
    }

    pub fn owner(&self) -> Address {
        self.owner.get_or_revert_with(Error::NotOwner)
    }

    pub fn per_call_cap(&self) -> U512 {
        self.per_call_cap.get_or_default()
    }

    pub fn total_approved(&self) -> U512 {
        self.total_approved.get_or_default()
    }

    fn ensure_owner(&self) {
        if self.env().caller() != self.owner.get_or_revert_with(Error::NotOwner) {
            self.env().revert(Error::NotOwner);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use odra::host::{Deployer, HostEnv};
    use std::panic::{catch_unwind, AssertUnwindSafe};

    fn setup() -> (SpendGuardrailHostRef, HostEnv, Address) {
        let env = odra_test::env();
        let owner = env.get_account(0);
        let contract = SpendGuardrail::deploy(
            &env,
            SpendGuardrailInitArgs {
                per_call_cap: U512::from(100u64),
            },
        );

        (contract, env, owner)
    }

    #[test]
    fn approves_amount_under_cap() {
        let (mut contract, env, _) = setup();
        let amount = U512::from(75u64);

        assert!(contract.check_and_record(amount));
        assert_eq!(contract.total_approved(), amount);
        assert!(env.emitted_event(
            &contract,
            ApprovedSpend {
                amount,
                result: true,
            },
        ));
    }

    #[test]
    fn rejects_amount_over_cap_without_updating_total() {
        let (mut contract, env, _) = setup();
        let amount = U512::from(125u64);

        assert!(!contract.check_and_record(amount));
        assert_eq!(contract.total_approved(), U512::zero());
        assert!(env.emitted_event(
            &contract,
            BlockedSpend {
                amount,
                result: false,
            },
        ));
    }

    #[test]
    fn only_owner_can_update_cap() {
        let (mut contract, env, owner) = setup();
        let new_cap = U512::from(250u64);

        env.set_caller(owner);
        contract.set_cap(new_cap);
        assert_eq!(contract.per_call_cap(), new_cap);

        let non_owner = env.get_account(1);
        env.set_caller(non_owner);
        let result = catch_unwind(AssertUnwindSafe(|| contract.set_cap(U512::from(500u64))));
        assert!(result.is_err());
        assert_eq!(contract.per_call_cap(), new_cap);
    }
}
