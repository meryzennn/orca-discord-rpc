namespace OrcaPresence
{
    /// <summary>
    /// The branch slot's artwork.
    ///
    /// Why only this: agent logos were removed. Discord renders only artwork registered on the
    /// application and accepts no external image, so per-agent logos could not work without an
    /// upload step that turned out to be more trouble than the picture was worth. The branch icon
    /// stays because its tooltip carries the branch name, which is real information.
    /// </summary>
    public static class AgentArt
    {
        /// <summary>Asset key for the branch icon, when artwork is registered on the application.</summary>
        public const string BranchArtKey = "git-branch";

        /// <summary>Public stand-in for the branch slot when nothing is uploaded.</summary>
        public const string BranchIconUrl =
            "https://www.google.com/s2/favicons?domain=git-scm.com&sz=128";
    }
}
