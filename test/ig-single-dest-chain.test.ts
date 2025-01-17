import { start, stop } from "./utils/server";
import { expect } from "chai";
import { ethers, Contract, Wallet } from "ethers";
import { setLogger } from "@axelar-network/axelar-local-dev";
import {
  deployComp,
  deployDummyState,
  deployGovernorAlpha,
  deployProposalExecutor,
  deployInterchainProposalSender,
  deployTimelock,
} from "./utils/deploy";
import { waitProposalExecuted } from "./utils/wait";
import { transferTimelockAdmin } from "./utils/timelock";
import { voteQueueExecuteProposal } from "./utils/governance";
import { sleep } from "./utils/sleep";
import { getChains } from "./utils/chains";
import { after } from "mocha";

setLogger(() => null);
console.log = () => null;

describe("Interchain Governance Executor For Single Destination Chain", function () {
  const deployer = Wallet.createRandom();
  let sender: Contract;
  let executor: Contract;
  let comp: Contract;
  let timelock: Contract;
  let governorAlpha: Contract;
  let dummyState: Contract;

  // redefine "slow" test for this test suite
  this.slow(15000);
  this.timeout(20000);

  before(async () => {
    // Start local chains
    await start([deployer.address]);

    const chains = getChains();

    // Deploy contracts
    sender = await deployInterchainProposalSender(deployer);
    executor = await deployProposalExecutor(deployer);
    comp = await deployComp(deployer);
    timelock = await deployTimelock(deployer);

    governorAlpha = await deployGovernorAlpha(
      deployer,
      timelock.address,
      comp.address
    );

    await executor.setWhitelistedProposalSender(
      chains[0].name,
      sender.address,
      true
    );

    // Whitelist the Governor contract to execute proposals
    await executor.setWhitelistedProposalCaller(
      chains[0].name,
      timelock.address,
      true
    );

    // Transfer ownership of the Timelock contract to the Governor contract
    await transferTimelockAdmin(timelock, governorAlpha.address);

    // Complete the Timelock contract ownership transfer
    await governorAlpha.__acceptAdmin();

    dummyState = await deployDummyState(deployer);
  });

  after(async () => {
    await stop();
  });

  it("should execute a proposal with a single destination target contract", async function () {
    // Delegate votes the COMP token to the deployer
    await comp.delegate(deployer.address);

    const targets = [dummyState.address];
    const values = [0];
    const signatures = ["setState(string)"];
    const calldatas = [
      ethers.utils.defaultAbiCoder.encode(["string"], ["Hello World"]),
    ];

    // Propose the payload to the Governor contract
    const axelarFee = ethers.utils.parseEther("0.0001");
    await governorAlpha.propose(
      [sender.address],
      [axelarFee],
      [
        "broadcastProposalToChain(string,string,address[],uint256[],string[],bytes[])",
      ],
      [
        ethers.utils.defaultAbiCoder.encode(
          ["string", "string", "address[]", "uint256[]", "string[]", "bytes[]"],
          [
            "Avalanche",
            executor.address,
            targets,
            values,
            signatures,
            calldatas,
          ]
        ),
      ],
      "Test Proposal"
    );

    // Read latest proposal ID created by deployer's address.
    const proposalId = await governorAlpha.latestProposalIds(deployer.address);
    console.log("Created Proposal ID:", proposalId.toString());

    // Vote, queue, and execute given proposal ID.
    await voteQueueExecuteProposal(
      deployer.address,
      proposalId,
      comp,
      governorAlpha,
      timelock,
      axelarFee
    );

    // Read proposal state
    const proposalState = await governorAlpha.state(proposalId);

    // Expect proposal to be in the succeeded state
    expect(proposalState).to.equal(7);

    // Wait for the proposal to be executed on the destination chain
    // Encode the payload for the destination chain
    const payload = ethers.utils.defaultAbiCoder.encode(
      ["address", "address[]", "uint256[]", "string[]", "bytes[]"],
      [timelock.address, targets, values, signatures, calldatas]
    );
    await waitProposalExecuted(payload, executor);

    // Expect the dummy state to be updated
    await expect(await dummyState.message()).to.equal("Hello World");
  });

  it("should execute a proposal with multiple destination target contracts", async function () {
    const dummyState2 = await deployDummyState(deployer);
    const dummyState3 = await deployDummyState(deployer);

    const encodeMsg = (msg: string) =>
      ethers.utils.defaultAbiCoder.encode(["string"], [msg]);

    // Encode the payload for the destination chain
    const targets = [
      dummyState.address,
      dummyState2.address,
      dummyState3.address,
    ];
    const values = [0, 0, 0];
    const signatures = [
      "setState(string)",
      "setState(string)",
      "setState(string)",
    ];
    const calldatas = [
      encodeMsg("Hello World1"),
      encodeMsg("Hello World2"),
      encodeMsg("Hello World3"),
    ];

    // Delegate votes the COMP token to the deployer
    await comp.delegate(deployer.address);

    // Propose the payload to the Governor contract
    const axelarFee = ethers.utils.parseEther("0.0001");
    await governorAlpha.propose(
      [sender.address],
      [axelarFee],
      [
        "broadcastProposalToChain(string,string,address[],uint256[],string[],bytes[])",
      ],
      [
        ethers.utils.defaultAbiCoder.encode(
          ["string", "string", "address[]", "uint256[]", "string[]", "bytes[]"],
          [
            "Avalanche",
            executor.address,
            targets,
            values,
            signatures,
            calldatas,
          ]
        ),
      ],
      { value: ethers.utils.parseEther("0.0001") }
    );

    const proposalId = await governorAlpha.latestProposalIds(deployer.address);
    console.log("Created Proposal ID:", proposalId.toString());

    // Vote, queue, and execute given proposal ID.
    await voteQueueExecuteProposal(
      deployer.address,
      proposalId,
      comp,
      governorAlpha,
      timelock,
      axelarFee
    );

    // Wait for the proposal to be executed on the destination chain
    const payload = ethers.utils.defaultAbiCoder.encode(
      ["address", "address[]", "uint256[]", "string[]", "bytes[]"],
      [timelock.address, targets, values, signatures, calldatas]
    );
    await waitProposalExecuted(payload, executor);

    expect(await dummyState.message()).to.equal("Hello World1");
    expect(await dummyState2.message()).to.equal("Hello World2");
    expect(await dummyState3.message()).to.equal("Hello World3");
  });

  it("should not execute if the call is initiated by an invalid InterchainProposalSender contract address", async function () {
    const maliciousSender = await deployInterchainProposalSender(deployer);
    const dummyContract = await deployDummyState(deployer);

    const targets = [dummyContract.address];
    const values = [0];
    const signatures = ["setState(string)"];
    const calldatas = [
      ethers.utils.defaultAbiCoder.encode(["string"], ["Hello World"]),
    ];

    await maliciousSender.broadcastProposalToChain(
      "Avalanche",
      executor.address,
      targets,
      values,
      signatures,
      calldatas,
      { value: ethers.utils.parseEther("0.0001") }
    );

    await sleep(5000);

    expect(await dummyContract.message()).to.equal("");
  });

  it("should not execute if the call is initiated by a non-whitelisted proposal caller address", async function () {
    const dummyContract = await deployDummyState(deployer);

    // Encode the payload for the destination chain
    const targets = [dummyContract.address];
    const values = [0];
    const signatures = ["setState(string)"];
    const calldatas = [
      ethers.utils.defaultAbiCoder.encode(["string"], ["Hello World"]),
    ];

    // try to execute the proposal
    await sender.broadcastProposalToChain(
      "Avalanche",
      executor.address,
      targets,
      values,
      signatures,
      calldatas,
      { value: ethers.utils.parseEther("0.0001") }
    );

    await sleep(5000);

    // Expect the dummy state to not be updated
    expect(await dummyContract.message()).to.equal("");

    const sourceChain = getChains()[0].name;

    // try to set the sender as a whitelisted proposal caller
    await executor.setWhitelistedProposalCaller(
      sourceChain,
      deployer.address,
      true
    );

    // try to execute the proposal again
    await sender.broadcastProposalToChain(
      "Avalanche",
      executor.address,
      targets,
      values,
      signatures,
      calldatas,
      {
        value: ethers.utils.parseEther("0.001"),
      }
    );

    // Wait for the proposal to be executed on the destination chain
    const payload = ethers.utils.defaultAbiCoder.encode(
      ["address", "address[]", "uint256[]", "string[]", "bytes[]"],
      [deployer.address, targets, values, signatures, calldatas]
    );
    await waitProposalExecuted(payload, executor);

    // Expect the dummy state to be updated
    expect(await dummyContract.message()).to.equal("Hello World");
  });
});
