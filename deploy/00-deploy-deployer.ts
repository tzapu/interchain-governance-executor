import { DeployFunction } from "hardhat-deploy/dist/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";

const deploy: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const [deployer] = await hre.getUnnamedAccounts();
  const { deploy } = hre.deployments;

  // const { deploy } = await deterministic("Deployer", {
  //   from: deployer,
  //   type: 2,
  // });

  const result = await deploy("Deployer",{
      from: deployer,
    });
  console.log("Deploy Deployer:", result.address);
};

deploy.tags = ["Deployer"];
deploy.skip = (env: HardhatRuntimeEnvironment) =>
  env.deployments.getOrNull("Deployer").then((d) => !!d);

export default deploy;
